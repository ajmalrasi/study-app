import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Sanitized public course metadata captured 2026-10-29: no session or captions.
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/dlai_agentic_outline.json',import.meta.url),'utf8'));
const source = fs.readFileSync(new URL('../extension/dlai.js',import.meta.url),'utf8');
class DOMParser {
  parseFromString(html) {
    const match = html.match(/<script id="__NEXT_DATA__">([\s\S]*?)<\/script>/);
    return {querySelector:()=>match ? {textContent:match[1]} : null, querySelectorAll:()=>[]};
  }
}
const ctx = vm.createContext({URL,AbortSignal,DOMParser,location:new URL('https://learn.deeplearning.ai/courses/agentic-ai/lesson/pu5xbv/welcome!')});
vm.runInContext(source.replace('export ',''),ctx);
const target='https://learn.deeplearning.ai/courses/agentic-ai/lesson/pu5xbv/welcome!';
let course, video, props, calls, redirect;
function reset() {
  course=structuredClone(fixture);
  video={videoId:course.lessons.pu5xbv.videoId,tracks:[
    {kind:'subtitles',srcLang:'fr-fr',src:'https://video.deeplearning.ai/fixtures/fr.vtt'},
    {kind:'subtitles',srcLang:'en-us',src:'https://video.deeplearning.ai/fixtures/en.vtt'},
    {kind:'chapters',srcLang:'en-us',src:'https://video.deeplearning.ai/fixtures/chapters.vtt'},
  ]};
  props={courseName:'agentic-ai',lessonId:'pu5xbv',session:{token:'must-never-leave-the-browser'}};
  calls=[];redirect=null;
  ctx.fetch=async url=>{
    calls.push(String(url));
    if (String(url).startsWith('https://learn.deeplearning.ai/')) return {ok:true,url:redirect||url,
      text:async()=>'<script id="__NEXT_DATA__">'+JSON.stringify({props:{pageProps:{...props,trpcState:{json:{queries:[{state:{data:course}},{state:{data:{video}}}]}}}}})+'</script>'};
    return {ok:true,text:async()=>'WEBVTT\n\n00:00.000 --> 00:02.000\nA teaching point\n'};
  };
}
reset();
let result=await ctx.fetchDlaiCourse('curriculum',target);
assert.equal(result.complete,true);
assert.equal(result.platform,'deeplearning');
assert.equal(result.platform_course_id,'10074');
assert.equal(result.sections.length,5);
assert.equal(result.item_count,55);
assert.equal(result.sections.flatMap(s=>s.items).filter(i=>i.kind==='video').length,31);
assert.equal(result.sections[1].id,'module-2');
assert.equal(result.sections[1].title,'Module 2: Reflection Design Pattern');
assert(result.sections[0].items.find(i=>i.id==='nae3i1').url.endsWith('what-is-agentic-ai%3F'));
assert.equal(result.sections[0].items.find(i=>i.id==='608l3k05').kind,'other','labs are not missing video transcripts');
assert(!JSON.stringify(result).includes('must-never-leave'),'session data is never transmitted');
reset();
assert.equal((await ctx.fetchDlaiCourse('curriculum','https://learn.deeplearning.ai/courses/agentic-ai')).complete,true,'course overview pages may expose the same complete inventory');

reset();course.listing[4].content.pop();
assert.match((await ctx.fetchDlaiCourse('curriculum',target)).error,/absent/,'a partial module list cannot be marked complete');
reset();course.listing[1].content.push(course.listing[0].content[0]);
assert.match((await ctx.fetchDlaiCourse('curriculum',target)).error,/duplicate/);
reset();delete course.lessons.nae3i1;
assert.match((await ctx.fetchDlaiCourse('curriculum',target)).error,/incomplete/);
reset();course.listing[0].content=[];
assert.match((await ctx.fetchDlaiCourse('curriculum',target)).error,/empty/);
reset();course.listing[0].content[0]={key:'unknown-subtopic',type:'subtopic'};
assert.match((await ctx.fetchDlaiCourse('curriculum',target)).error,/incomplete/,'unknown outline structures fail explicitly');

reset();result=await ctx.fetchDlaiCourse('caption',target);
assert(result.vtt.startsWith('WEBVTT'));
assert.equal(calls[1],'https://video.deeplearning.ai/fixtures/en.vtt');
assert.equal(calls.length,2,'no video playback or video file downloads');
reset();props.lessonId='nae3i1';
assert.match((await ctx.fetchDlaiCourse('caption',target)).error,/requested video/,'a prior lesson cannot supply captions');
reset();video.videoId=999;
assert.match((await ctx.fetchDlaiCourse('caption',target)).error,/not accessible/);
reset();video=null;
result=await ctx.fetchDlaiCourse('caption',target);
assert(result.error && !result.noCaptions,'restricted access is not misreported as missing captions');
reset();video.tracks=[];
assert.equal((await ctx.fetchDlaiCourse('caption',target)).noCaptions,true);
reset();video.tracks=[];video.subtitle=JSON.stringify({'en-us':{URI:'https://video.deeplearning.ai/fixtures/english.vtt'}});
assert.equal((await ctx.fetchDlaiCourse('caption',target)).src,'https://video.deeplearning.ai/fixtures/english.vtt');
reset();
const htmlFetch=ctx.fetch;
ctx.fetch=async url=>String(url).startsWith('https://learn.deeplearning.ai/') ? htmlFetch(url) : {
  ok:true,text:async()=>String(url).endsWith('en.vtt') ? '#EXTM3U\npart-1.vtt\npart-2.vtt\n'
    : 'WEBVTT\n\n00:00.000 --> 00:02.000\nA teaching point\n'};
const playlist=await ctx.fetchDlaiCourse('caption',target);
assert.equal(playlist.vtt.match(/WEBVTT/g).length,1,'playlist headers are stripped when joining subtitle segments');
assert.equal(playlist.vtt.match(/A teaching point/g).length,2,'all subtitle segments are retained');
reset();redirect='https://auth.deeplearning.ai/login';
assert.match((await ctx.fetchDlaiCourse('caption',target)).error,/sign-in/);
reset();assert.match((await ctx.fetchDlaiCourse('caption',target.replace('agentic-ai','another-course'))).error,/course open/);
reset();video.tracks=[{kind:'subtitles',srcLang:'en',src:'https://evil.example/captions.vtt'}];
assert.match((await ctx.fetchDlaiCourse('caption',target)).error,/outside/);
assert.equal(calls.length,1,'never fetch an unrelated caption host');
console.log('DeepLearning.AI tests passed: five complete modules, 50 exact lesson IDs, 31 videos, caption identity, access errors and session isolation.');
