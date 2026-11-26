"""Load the Pi's pinned BGE artifact and encode course passages and questions."""
import argparse
from pathlib import Path
from threading import Lock
from urllib.request import urlopen


REVISION = "aa8f8b060edb00e03bfdd08813a2949946c8ba55"
MODEL_ID = f"bge-small-en-v1.5:{REVISION}:cls-v1"
REPOSITORY = f"https://huggingface.co/Qdrant/bge-small-en-v1.5-onnx-Q/resolve/{REVISION}"
PREFIX = "Represent this sentence for searching relevant passages: "
DIMENSIONS = 384
TARGET_TOKENS = 320
CHUNK_TOKENS = 450
MAX_TOKENS = 512
MODEL_FILES = ("tokenizer.json", "model_optimized.onnx")


class Encoder:
    def __init__(self, directory):
        from tokenizers import Tokenizer

        self.directory = directory
        self.tokenizer = Tokenizer.from_file(str(directory / "tokenizer.json"))
        self.tokenizer.no_truncation()
        self.tokenizer.no_padding()
        self.model_id = MODEL_ID
        self.session = None
        self.lock = Lock()

    def count(self, text):
        return len(self.tokenizer.encode(text).ids)

    def embed(self, texts, *, query=False):
        import numpy as np
        import onnxruntime as ort

        texts = [PREFIX + text for text in texts] if query else texts
        tokens = self.tokenizer.encode_batch(texts)
        width = max(len(token.ids) for token in tokens)
        if width > MAX_TOKENS:
            raise ValueError("Text exceeds the BGE input limit")
        pad_id = self.tokenizer.token_to_id("[PAD]")
        inputs = {name: np.full((len(tokens), width), value, dtype=np.int64) for name, value in
                  (("input_ids", pad_id), ("attention_mask", 0), ("token_type_ids", 0))}
        for i, token in enumerate(tokens):
            end = len(token.ids)
            inputs["input_ids"][i, :end] = token.ids
            inputs["attention_mask"][i, :end] = token.attention_mask
            inputs["token_type_ids"][i, :end] = token.type_ids

        with self.lock:
            if self.session is None:
                options = ort.SessionOptions()
                options.intra_op_num_threads = 2
                options.inter_op_num_threads = 1
                self.session = ort.InferenceSession(str(self.directory / "model_optimized.onnx"),
                                                    sess_options=options, providers=["CPUExecutionProvider"])
            hidden = self.session.run(["last_hidden_state"],
                                      {item.name: inputs[item.name] for item in self.session.get_inputs()})[0]
        vectors = hidden[:, 0, :]
        norms = np.linalg.norm(vectors, axis=1, keepdims=True)
        if vectors.shape != (len(texts), DIMENSIONS) or not np.isfinite(vectors).all() or (norms == 0).any():
            raise ValueError("Unexpected embedding output")
        return (vectors / norms).tolist()


def provision(directory):
    directory.mkdir(parents=True, exist_ok=True)
    for filename in MODEL_FILES:
        path = directory / filename
        if not path.exists():
            temporary = path.with_suffix(path.suffix + ".part")
            with urlopen(f"{REPOSITORY}/{filename}", timeout=180) as source, temporary.open("wb") as target:
                while block := source.read(1024 * 1024):
                    target.write(block)
            temporary.replace(path)
    encoder = Encoder(directory)
    # Exercise a real long input on the deployment architecture before restarting the web app.
    text = "planning " * (CHUNK_TOKENS - 2)
    if encoder.count(text) <= 256 or len(encoder.embed([text])[0]) != DIMENSIONS:
        raise RuntimeError("BGE did not pass the long-passage readiness check")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    provision(parser.parse_args().directory)
