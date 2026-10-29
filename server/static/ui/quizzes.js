// The library owns quizzes; each practice run owns a separate durable attempt.
export function createQuizWorkspace({ api, esc, icon, fmt, videoLink, setPage, setBreadcrumb, navigate, toast }) {
  let active = false, poll, draftTimer, scopes = [], quiz = null, attempt = null, index = 0;
  let courseId = null, busy = false, saving = Promise.resolve(), createRequest = null, viewKey = '';
  const $ = (s) => document.querySelector(s);
  const checked = (name) => [...document.querySelectorAll(`input[name="${name}"]:checked`)].map(n => Number(n.value));
  const statusLabel = { queued: "Waiting to generate", running: "Generating", ready: "Ready", partial: "Partial coverage", error: "Needs attention", paused: "Paused" };
  const draftKey = (aid, qid) => `sn-quiz-draft:${aid}:${qid}`;
  const readDraft = (aid, qid) => { try { return JSON.parse(localStorage.getItem(draftKey(aid, qid))); } catch { return null; } };
  const writeDraft = (aid, qid, value) => { try { localStorage.setItem(draftKey(aid, qid), JSON.stringify(value)); } catch { /* The server still saves drafts. */ } };
  const clearDraft = (aid, qid) => { try { localStorage.removeItem(draftKey(aid, qid)); } catch {} };
  const date = (t) => new Date(t * 1000).toLocaleString();
  const action = (name, label, extra = "", primary = false) => `<button class="button${primary ? " primary" : ""}" data-quiz-action="${name}" ${extra}>${label}</button>`;
  const errorMarkup = (text) => `<p class="quiz-warning" role="alert">${esc(text)}</p>`;

  function course() { return scopes.find(c => c.id === courseId) || scopes[0]; }
  function scopeMarkup() {
    const c = course();
    if (!c) return '<p class="muted">Save a lesson with the extension to start creating quizzes.</p>';
    const available = c.lessons.filter(l => l.has_transcript);
    return `<label class="field-label" for="q-mode">Choose material</label><select id="q-mode" class="select">
      ${c.inventory ? `<option value="sections">Selected ${c.inventory.platform === 'deeplearning' ? 'modules' : 'sections'}</option><option value="course">Entire course</option>` : ''}
      <option value="saved">Selected saved lessons</option></select>
      ${!c.inventory ? `<p class="small muted">Open this course on Udemy or DeepLearning.AI, then choose <strong>Sync course sections</strong> in the Study Notes extension to see its complete outline. Saved lesson selection covers only the lessons listed below.</p>` : `<p class="small muted">Complete curriculum synced ${esc(date(c.inventory.synced))}. Refresh it in the extension when the course changes.</p>`}
      <div id="q-sections" class="quiz-selection" ${c.inventory ? '' : 'hidden'}>${c.sections.map((s, i) => `<label class="quiz-select-row"><input type="checkbox" name="q-section" value="${s.id}" ${i === 0 ? 'checked' : ''}><span><strong>${esc(s.title)}</strong><small>${s.available} of ${s.videos} video transcripts saved · ${s.items.length - s.videos} other items</small></span></label>`).join('')}</div>
      <div id="q-lessons" class="quiz-selection" ${c.inventory ? 'hidden' : ''}>${c.lessons.map(l => `<label class="quiz-select-row"><input type="checkbox" name="q-lesson" value="${l.id}" ${l.has_transcript ? 'checked' : ''}><span>${esc(l.title)}<small>${l.has_transcript ? 'Transcript saved' : 'Transcript missing'}</small></span></label>`).join('') || '<p>No saved lessons yet.</p>'}</div>
      <p id="q-coverage" class="quiz-coverage" role="status"></p>
      <div id="q-missing"></div>
      <div class="flex wrap">${action('import', 'Fetch missing transcripts', 'id="q-import"')}<span class="small muted" id="q-import-hint">Keep this course open in signed-in Chrome with Study Notes enabled. Imports start within a minute.</span></div>
      <p class="small muted">All included transcripts will be processed. The finished quiz shows which lessons its questions cover.</p>
      <label class="quiz-select-row"><input id="q-partial" type="checkbox"><span>Allow a partial quiz if transcripts are missing</span></label>
      <div class="quiz-form-grid"><div><label class="field-label" for="q-count">Number of questions</label><input id="q-count" type="number" min="1" max="100" value="20" required></div>
      <div><label class="field-label" for="q-kind">Answer format</label><select id="q-kind" class="select"><option value="written">Written answers</option><option value="mcq">Multiple choice</option></select></div></div>
      <label class="field-label" for="q-title">Quiz name (optional)</label><input id="q-title" maxlength="200" placeholder="For example, IAM revision">
      ${action('create', icon('sparkles') + ' Create saved quiz', available.length || c.inventory ? '' : 'disabled', true)}
      <p id="q-create-status" class="small muted" role="status"></p>`;
  }

  function selection() {
    const c = course(), mode = $('#q-mode')?.value;
    const sections = mode === 'course' ? c.sections : c.sections.filter(s => checked('q-section').includes(s.id));
    if (mode === 'saved') {
      const lessons = c.lessons.filter(l => checked('q-lesson').includes(l.id));
      return { available: lessons.filter(l => l.has_transcript).length, total: lessons.length,
        missing: lessons.filter(l => !l.has_transcript), section_ids: [], lesson_ids: lessons.map(l => l.id) };
    }
    return { available: sections.reduce((n,s) => n + s.available, 0), total: sections.reduce((n,s) => n + s.videos, 0),
      missing: sections.flatMap(s => s.items.filter(i => i.kind === 'video' && !i.has_transcript)),
      section_ids: sections.map(s => s.id), course_id: c.id };
  }

  function updateCoverage() {
    const c = course();
    if (!c || !$('#q-mode')) return;
    const mode = $('#q-mode').value, s = selection();
    $('#q-sections').hidden = mode !== 'sections';
    $('#q-lessons').hidden = mode !== 'saved';
    $('#q-coverage').textContent = `${s.available} of ${s.total} selected video transcripts available${mode === 'saved' ? ' · Saved lessons only' : ''}`;
    $('#q-missing').innerHTML = s.missing.length ? `<details class="quiz-missing"><summary>${s.missing.length} missing transcripts</summary><ul>${s.missing.map(i => `<li>${esc(i.title)}</li>`).join('')}</ul></details>` : '';
    $('#q-import').hidden = mode === 'saved' || !s.missing.length;
    $('#q-import-hint').hidden = $('#q-import').hidden;
  }

  function quizCard(q) {
    return `<a class="quiz-library-card" href="#quizzes?quiz=${q.id}"><div class="flex between wrap"><h3>${esc(q.title)}</h3><span class="tag">${esc(statusLabel[q.status] || q.status)}</span></div>
      <p>${q.question_count} of ${q.requested} questions · ${q.lessons} lessons · ${q.kind === 'mcq' ? 'Multiple choice' : 'Written answers'}</p>
      <p class="small muted">${esc(['queued','running'].includes(q.status) ? q.step || 'Waiting to start' : date(q.created))}</p></a>`;
  }

  async function library() {
    [scopes, quiz] = await Promise.all([api('/api/quiz-scopes'), api('/api/quizzes')]);
    if (!active || viewKey !== 'library') return;
    if (!scopes.some(c => c.id === courseId)) courseId = scopes[0]?.id;
    setPage('Quizzes', `<div class="intro"><div class="eyebrow">Learn across lessons</div><h1>Your quiz library</h1><p class="muted">Create once, practise again, and keep every attempt.</p></div>
      <details class="quiz-create" open><summary>Create a quiz</summary><div class="quiz-create-body"><label class="field-label" for="q-course">Course</label>
      <select id="q-course" class="select">${scopes.map(c => `<option value="${c.id}" ${c.id === courseId ? 'selected' : ''}>${esc(c.title)}</option>`).join('')}</select>
      <div id="q-scope">${scopeMarkup()}</div></div></details>
      <section><div class="section-heading"><h2>Saved quizzes</h2>${action('refresh', 'Refresh')}</div><div class="quiz-library">${quiz.map(quizCard).join('') || '<p class="muted">Your saved quizzes will appear here.</p>'}</div></section>
      <div id="q-imports"></div>`);
    updateCoverage();
    await refreshImports();
    if (quiz.some(q => ['queued','running'].includes(q.status))) poll = setTimeout(refreshCards, 5000);
  }

  async function refreshCards() {
    if (!active || attempt || !$('#q-scope')) return;
    try {
      const quizzes = await api('/api/quizzes');
      if (!active || !$('.quiz-library')) return;
      $('.quiz-library').innerHTML = quizzes.map(quizCard).join('') || '<p class="muted">No saved quizzes yet.</p>';
      if (quizzes.some(q => ['queued','running'].includes(q.status))) poll = setTimeout(refreshCards, 5000);
    } catch (e) { toast(e.message, true); }
  }

  async function refreshImports() {
    if (!active || !$('#q-imports')) return;
    const imports = await api('/api/transcript-imports');
    if (!active || !$('#q-imports')) return;
    $('#q-imports').innerHTML = imports.length ? `<section class="quiz-imports"><h2>Transcript imports</h2>${imports.slice(0,4).map(j => `<details><summary>${j.done} of ${j.total} processed · ${esc(j.status)}</summary><ul>${j.items.map(i => `<li>${esc(i.title)} · ${esc(i.status)}${i.error ? ': ' + esc(i.error) : ''}</li>`).join('')}</ul></details>`).join('')}<p class="small muted">Refresh coverage after an import finishes. Unavailable captions remain listed.</p></section>` : '';
  }

  async function detail(id) {
    quiz = await api('/api/quizzes/' + id);
    if (!active || viewKey !== 'quiz:' + id) return;
    const q = quiz, generating = ['queued','running'].includes(q.status);
    setPage(q.title, `<div class="intro"><a class="text-button" href="#quizzes">← Quiz library</a><h1>${esc(q.title)}</h1><span class="tag">${esc(statusLabel[q.status])}</span></div>
      <div class="quiz-panel"><h2>${q.question_count} questions saved${q.question_count !== q.requested ? ' of ' + q.requested + ' requested' : ''}</h2>
      <p>${q.processed_chunks} of ${q.chunks} transcript chunks processed · ${q.represented} of ${q.lessons} included lessons represented by questions</p>
      ${generating ? `<p class="job-status" role="status"><span class="spinner"></span>${esc(q.step || 'Waiting to generate…')}</p><p class="small muted">You can leave this page. Generation and source material are saved on the server.</p>${action('pause', 'Pause generation')}` : ''}
      ${q.error ? errorMarkup(q.error) : ''}
      ${q.status === 'error' || q.status === 'paused' ? action('resume', 'Resume generation', '', true) : ''}
      ${['ready','partial'].includes(q.status) && q.question_count ? action('start', q.attempts.length ? 'Start a new attempt' : 'Start quiz', '', true) : ''}
      <p class="small muted">${q.scope.verified_inventory ? 'Section membership verified against the synced curriculum.' : 'Based on your explicit saved lesson selection.'} ${q.scope.non_video_items || 0} non-video items excluded.</p></div>
      <details class="quiz-panel"><summary>Source coverage</summary><ul>${q.coverage.map(l => `<li>${esc(l.title)} · ${l.represented ? 'Represented' : 'No question yet'}${l.source_changed ? ' · Source has changed; this quiz retains its original evidence' : ''}</li>`).join('')}</ul>
      ${q.omissions.length ? `<h3>Missing transcripts excluded from this quiz</h3><ul>${q.omissions.map(o => `<li>${esc(o.title)}</li>`).join('')}</ul>` : ''}</details>
      <section><h2>Your attempts</h2><div class="quiz-library">${q.attempts.map(a => `<a class="quiz-library-card" href="#quizzes?attempt=${a.id}"><strong>${a.status === 'completed' ? 'Review results' : 'Resume attempt'}</strong><p>${a.answered} of ${a.total} checked · ${a.score}/${a.max_score} points</p><span class="small muted">${esc(date(a.created))}</span></a>`).join('') || '<p class="muted">No attempts yet. Every attempt saves separately.</p>'}</div></section>`);
    if (generating) poll = setTimeout(() => detail(id).catch(e => toast(e.message, true)), 5000);
  }

  async function loadAttempt(id, preserveIndex = false) {
    const data = await api('/api/quiz-attempts/' + id);
    if (!active || viewKey !== 'attempt:' + id) return;
    attempt = data;
    if (!preserveIndex) index = Math.max(0, data.questions.findIndex(q => !q.response.feedback));
    index = Math.min(index, data.questions.length - 1);
    renderAttempt();
  }

  function renderAttempt() {
    if (!active || !attempt) return;
    const a = attempt, q = a.questions[index], r = q.response, cached = readDraft(a.id, q.id);
    const value = !r.feedback && cached ? cached : r;
    const conflict = !r.feedback && cached && cached.base_version !== r.version;
    setPage(a.title, `<div class="intro"><a class="text-button" href="#quizzes?quiz=${a.quiz_id}">← ${esc(a.title)}</a><h1>${a.status === 'completed' ? 'Your results' : 'A little practice'}</h1><p class="muted">${a.answered} of ${a.total} answers checked · ${a.score}/${a.max_score} points${a.questions.some(q => q.kind === 'written') ? ' · Written scores are AI feedback; verify with the source.' : ''}</p></div>
      <nav class="quiz-pagination" aria-label="Quiz questions">${a.questions.map((item,i) => `<button class="button ${i === index ? 'primary' : ''}" data-quiz-action="question" data-index="${i}" ${busy ? 'disabled' : ''} ${i === index ? 'aria-current="step"' : ''} aria-label="Question ${i+1}${item.response.feedback ? ', checked' : ''}">${i+1}${item.response.feedback ? ' ✓' : ''}</button>`).join('')}</nav>
      <section class="quiz-question"><div class="eyebrow">Question ${index+1} of ${a.total}</div><h2>${esc(q.question)}</h2>
      ${q.kind === 'mcq' ? `<fieldset class="quiz-choices"><legend class="field-label">Your answer</legend>${q.choices.map((choice,i) => `<label class="quiz-select-row"><input type="radio" name="q-choice" value="${i}" ${value.choice === i ? 'checked' : ''} ${busy || r.feedback ? 'disabled' : ''}><span>${esc(choice)}</span></label>`).join('')}</fieldset>` : `<label class="field-label" for="q-answer">Your answer</label><textarea id="q-answer" rows="6" maxlength="8000" placeholder="Explain it in your own words…" ${busy || r.feedback ? 'disabled' : ''}>${esc(value.answer)}</textarea>`}
      ${conflict ? errorMarkup('Another tab saved a newer answer. Your unsynced draft is shown above. Choose which answer to keep.') +
        `<p>Saved answer: ${esc(q.kind === 'mcq' ? q.choices[r.choice] || '(no answer selected)' : r.answer || '(empty)')}</p><div class="flex wrap">${action('use-saved','Use saved answer')}${action('keep-draft','Keep my draft')}</div>` : ''}
      ${r.feedback ? `<div class="quiz-feedback"><h3>${r.feedback.score === 2 ? 'Correct' : r.feedback.score === 1 ? 'Partly correct' : 'Worth revisiting'} · ${r.feedback.score}/2</h3><p>${esc(r.feedback.feedback)}</p><h3>Expected answer</h3><p>${esc(q.answer)}</p><p>${esc(q.explanation)}</p></div><details class="quiz-sources"><summary>Check the source evidence</summary>${q.sources.map(s => `<article><h3>${esc(s.title)} · ${fmt(s.t)}</h3><blockquote>${esc(s.text)}</blockquote>${videoLink(s.url_key,s.t,'Watch this lesson')}</article>`).join('')}</details>` : `<div class="flex wrap">${action('check', busy ? 'Checking your answer…' : 'Check my answer', busy || conflict ? 'disabled' : '', true)}${action('save', 'Save answer', busy || conflict ? 'disabled' : '')}</div>`}
      <p id="q-save-status" class="small muted" role="status">${r.feedback ? 'Answer and feedback saved.' : busy ? 'Your answer is saved. Checking against the source…' : 'Drafts save as you type. You can leave and resume.'}</p>
      <div class="flex between quiz-question-nav">${action('previous', 'Previous', index === 0 || busy ? 'disabled' : '')}${action('next', 'Next', index === a.total-1 || busy ? 'disabled' : '')}</div></section>
      <div class="flex wrap quiz-attempt-actions">${a.status === 'active' && a.answered === a.total ? action('finish', 'Complete attempt', '', true) : ''}
      ${a.status === 'completed' ? action('retake', 'Retake quiz') + (a.questions.some(q => q.response.feedback?.score < 2) ? action('missed', 'Practise missed questions') : '') : ''}
      <a class="button" href="#quizzes?quiz=${a.quiz_id}">${a.status === 'completed' ? 'Back to quiz' : 'Leave and resume later'}</a></div>`);
  }

  function captureDraft() {
    if (!attempt) return;
    const q = attempt.questions[index];
    if (q.response.feedback) return;
    const old = readDraft(attempt.id, q.id);
    const answer = $('#q-answer')?.value ?? old?.answer ?? q.response.answer;
    const selected = $('input[name="q-choice"]:checked');
    const choice = selected ? Number(selected.value) : old?.choice ?? q.response.choice;
    writeDraft(attempt.id, q.id, { answer, choice, base_version: old?.base_version ?? q.response.version });
  }

  function saveDraft() {
    clearTimeout(draftTimer);
    const a = attempt, q = a?.questions[index];
    if (!q || q.response.feedback) return saving;
    const pending = readDraft(a.id, q.id);
    if (!pending) return saving;
    saving = saving.catch(() => {}).then(async () => {
      const draft = readDraft(a.id, q.id);
      if (!draft) return;
      if (draft.base_version !== q.response.version) throw new Error('This draft conflicts with a newer saved answer. Reload to compare before saving.');
      let result;
      try {
        result = await api(`/api/quiz-attempts/${a.id}/responses/${q.id}`, {method:'PUT',body:{answer:draft.answer,choice:draft.choice,expected_version:q.response.version}});
      } catch (e) {
        if (e.status === 409 && active && viewKey === 'attempt:' + a.id) await loadAttempt(a.id,true);
        throw e;
      }
      q.response = {...q.response,answer:draft.answer,choice:draft.choice,version:result.version};
      const latest = readDraft(a.id,q.id);
      if (latest && latest.answer === draft.answer && latest.choice === draft.choice) clearDraft(a.id,q.id);
      else if (latest) writeDraft(a.id,q.id,{...latest,base_version:result.version});
      if (active && attempt === a && a.questions[index].id === q.id && $('#q-save-status')) $('#q-save-status').textContent = 'Draft saved.';
    });
    saving.catch(e => { if (active && $('#q-save-status')) $('#q-save-status').textContent = e.message + ' Your draft remains in this browser.'; });
    return saving;
  }

  document.addEventListener('input', e => {
    if (!active) return;
    if (e.target.matches('#q-answer,input[name="q-choice"]')) {
      captureDraft();
      clearTimeout(draftTimer);
      draftTimer = setTimeout(saveDraft, 600);
    } else if (e.target.closest('#q-scope')) createRequest = null;
  });
  document.addEventListener('change', e => {
    if (!active) return;
    if (e.target.id === 'q-course') {
      courseId = Number(e.target.value);
      $('#q-scope').innerHTML = scopeMarkup();
      createRequest = null;
      updateCoverage();
    } else if (e.target.id === 'q-mode' || e.target.name === 'q-section' || e.target.name === 'q-lesson') {
      createRequest = null;
      updateCoverage();
    }
  });

  document.addEventListener('click', async e => {
    const button = e.target.closest('[data-quiz-action]');
    if (!active || !button || button.disabled) return;
    const name = button.dataset.quizAction;
    if (busy) return;
    button.disabled = true;
    try {
      if (name === 'refresh') { await load(new URLSearchParams()); return; }
      if (name === 'create') {
        const s = selection(), count = Number($('#q-count').value);
        if (!s.total || !s.available) throw new Error('Choose lessons with available transcripts.');
        if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('Choose 1–100 questions.');
        createRequest ??= crypto.randomUUID();
        $('#q-create-status').textContent = 'Saving your selection and transcript evidence…';
        const q = await api('/api/quizzes',{method:'POST',body:{request_id:createRequest,title:$('#q-title').value,
          count,kind:$('#q-kind').value,allow_partial:$('#q-partial').checked,
          ...(s.lesson_ids ? {lesson_ids:s.lesson_ids} : {course_id:s.course_id,section_ids:$('#q-mode').value === 'course' ? [] : s.section_ids})}});
        createRequest = null;
        navigate('#quizzes?quiz='+q.id);
      } else if (name === 'import') {
        const s = selection();
        if (!s.section_ids.length) throw new Error('Select at least one section.');
        await api('/api/transcript-imports',{method:'POST',body:{section_ids:s.section_ids}});
        toast('Import queued. Keep the signed-in course tab open with the updated extension.');
        await refreshImports();
      } else if (name === 'pause' || name === 'resume') {
        await api(`/api/quizzes/${quiz.id}/${name}`,{method:'POST'});
        clearTimeout(poll);
        await detail(quiz.id);
      } else if (name === 'start' || name === 'retake' || name === 'missed') {
        const qid = attempt?.quiz_id || quiz.id;
        const a = await api(`/api/quizzes/${qid}/attempts`,{method:'POST',body:{request_id:crypto.randomUUID(),...(name === 'missed' ? {missed_from:attempt.id} : {})}});
        navigate('#quizzes?attempt='+a.id);
      } else if (name === 'save') {
        captureDraft(); await saveDraft(); toast('Answer saved.');
      } else if (name === 'use-saved') {
        clearDraft(attempt.id,attempt.questions[index].id);
      } else if (name === 'keep-draft') {
        const q = attempt.questions[index], draft = readDraft(attempt.id,q.id);
        if (draft) writeDraft(attempt.id,q.id,{...draft,base_version:q.response.version});
        await saveDraft();
      } else if (name === 'question' || name === 'previous' || name === 'next') {
        captureDraft(); await saveDraft();
        index = name === 'question' ? Number(button.dataset.index) : index + (name === 'next' ? 1 : -1);
        renderAttempt();
      } else if (name === 'check') {
        captureDraft(); await saveDraft();
        const aid = attempt.id, q = attempt.questions[index];
        busy = true; renderAttempt();
        await api(`/api/quiz-attempts/${aid}/responses/${q.id}/check`,{method:'POST',body:{expected_version:q.response.version}});
        if (active && viewKey === 'attempt:' + aid) await loadAttempt(aid,true);
      } else if (name === 'finish') {
        attempt = await api(`/api/quiz-attempts/${attempt.id}/finish`,{method:'POST'});
        renderAttempt();
      }
    } catch (e) { toast(e.message,true); }
    finally { busy = false; if (active && attempt) renderAttempt(); else if (button.isConnected) button.disabled = false; }
  });

  async function load(params) {
    clearTimeout(poll);
    active = true; quiz = null; attempt = null; busy = false;
    viewKey = params.get('attempt') ? 'attempt:' + params.get('attempt') : params.get('quiz') ? 'quiz:' + params.get('quiz') : 'library';
    setBreadcrumb([['Quizzes','#quizzes']]);
    if (params.get('attempt')) await loadAttempt(params.get('attempt'));
    else if (params.get('quiz')) await detail(params.get('quiz'));
    else await library();
  }
  return { load, async leave() {
    clearTimeout(poll); clearTimeout(draftTimer);
    if (attempt && active) { captureDraft(); try { await saveDraft(); } catch { /* Unsynced draft is retained locally. */ } }
    active = false; attempt = null; quiz = null;
  } };
}
