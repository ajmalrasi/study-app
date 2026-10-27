import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../extension/page.js',import.meta.url),'utf8');
const ctx = vm.createContext({URL,AbortSignal,location:new URL('https://www.udemy.com/course/aws/'),console});
vm.runInContext(source.replaceAll('export ',''),ctx);
const pages = [
  {count:5,next:'/api-2.0/courses/123/subscriber-curriculum-items/?page=2',results:[
    {_class:'chapter',id:10,title:'IAM'}, {_class:'lecture',id:101,title:'Users',asset:{asset_type:'Video'}}]},
  {count:5,next:null,results:[
    {_class:'lecture',id:102,title:'CLI',asset:{asset_type:'Video'}},
    {_class:'lecture',id:103,title:'Reading',asset:{asset_type:'Article'}},
    {_class:'quiz',id:104,title:'Quiz'}]},
];
let calls=[];
ctx.fetch = async url => {calls.push(String(url));return {ok:true,json:async()=>pages[calls.length-1]};};
let result = await ctx.fetchUdemyCurriculum(123);
assert.equal(result.complete,true);
assert.equal(result.item_count,5);
assert.equal(result.sections[0].items.length,4,'pagination cannot silently drop later lessons');
assert.equal(result.sections[0].items[1].title,'CLI','membership does not depend on IAM keywords');
assert.equal(result.sections[0].items[2].kind,'article');
assert.equal(result.sections[0].items[3].kind,'quiz');
assert.equal(calls.length,2);

ctx.fetch = async()=>({ok:true,json:async()=>({...pages[0],next:'https://evil.example/curriculum'})});
assert.match((await ctx.fetchUdemyCurriculum(123)).error,/invalid/,'never follow foreign pagination links');
ctx.fetch = async()=>({ok:true,json:async()=>({...pages[0],next:null})});
assert.match((await ctx.fetchUdemyCurriculum(123)).error,/missing/);
ctx.fetch = async()=>({ok:false,status:403});
assert.match((await ctx.fetchUdemyCurriculum(123)).error,/403/);

const vtt='WEBVTT\n\n00:00.000 --> 00:02.000\nA missing lesson caption\n';
calls=[];
ctx.fetch=async url=>{calls.push(String(url));return {ok:true,json:async()=>({asset:{captions:[
  {locale_id:'fr_FR',status:1,url:'https://captions.example/fr.vtt'},
  {locale_id:'en_US',status:1,url:'https://captions.example/en.vtt'},
]} }),text:async()=>vtt};};
result = await ctx.fetchUdemyCaption(123,102);
assert.equal(result.vtt,vtt,'bulk captions do not require opening a video or a video element');
assert(calls[0].includes('/123/lectures/102/'));
assert.equal(calls[1],'https://captions.example/en.vtt');
ctx.fetch=async()=>({ok:true,json:async()=>({asset:{captions:[]}})});
assert.equal((await ctx.fetchUdemyCaption(123,102)).noCaptions,true);
ctx.fetch=async()=>({ok:false,status:403});
assert.match((await ctx.fetchUdemyCaption(123,102)).error,/403/);
ctx.location=new URL('https://udemy.com.evil.example/course/aws');
assert.match((await ctx.fetchUdemyCaption(123,102)).error,/signed-in/);
console.log('Udemy curriculum tests passed: complete pagination, exact membership, content types, access errors and captions without playback.');
