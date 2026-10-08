/**
 * Bundled by jsDelivr using Rollup v4.62.2 and esbuild v0.28.1.
 * Original file: /npm/@lit/reactive-element@2.1.2/decorators/query-all.js
 *
 * Do NOT use SRI with dynamically generated files! More information: https://www.jsdelivr.com/using-sri-with-dynamic-files
 */
const o=(r,t,e)=>(e.configurable=!0,e.enumerable=!0,Reflect.decorate&&typeof t!="object"&&Object.defineProperty(r,t,e),e);let n;function u(r){return(t,e)=>o(t,e,{get(){return(this.renderRoot??(n??=document.createDocumentFragment())).querySelectorAll(r)}})}export{u as queryAll};
