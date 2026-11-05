const t0 = performance.now();
const mod = await import('@langchain/langgraph');
const t1 = performance.now();
const keys = Object.keys(mod).sort();
console.log('ESM import OK in', (t1-t0).toFixed(0)+'ms');
console.log('export count:', keys.length);
console.log('has:', ['StateGraph','Annotation','MemorySaver','interrupt','Command','START','END','MessagesAnnotation','CompiledStateGraph','BaseCheckpointSaver','Send','END'].map(k=>`${k}=${keys.includes(k)}`).join(' '));
const cp = await import('@langchain/langgraph-checkpoint');
console.log('checkpoint pkg keys:', Object.keys(cp).sort().join(','));
