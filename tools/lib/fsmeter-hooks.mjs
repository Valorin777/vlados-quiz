// Module resolve hook (node:module register): every `firebase/firestore` import — the app code
// included — gets the metering wrapper in fsmeter.mjs, which re-exports the real SDK.
const METER = new URL('./fsmeter.mjs', import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === 'firebase/firestore') return { url: METER, shortCircuit: true };
  return next(specifier, context);
}
