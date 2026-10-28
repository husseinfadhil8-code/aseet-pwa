import test from 'node:test';import assert from 'node:assert/strict';import{decodeSearchLaunch}from'../miniapp/search-launch.js';
const encode=q=>'search_'+Buffer.from(q).toString('base64url');
test('deep search decodes Iraqi Arabic and rejects invalid or unbounded input',()=>{assert.equal(decodeSearchLaunch(encode('ثلاجة')),'ثلاجة');assert.equal(decodeSearchLaunch('add'),null);assert.equal(decodeSearchLaunch(encode('x'.repeat(61))),null);assert.equal(decodeSearchLaunch(encode('a\nb')),null)});
