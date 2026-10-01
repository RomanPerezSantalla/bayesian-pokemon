/**
 * Whether this worker is one of the ONNX runtime's own threads. With several threads (the page is
 * cross-origin isolated), the runtime starts each from the file its code is in, and in a build that's
 * the worker it was bundled into: in those copies the runtime takes the messages, and the worker's own
 * handler mustn't replace its (the threads would never start, and loading would wait forever).
 */
export const isOrtThread = () => !!(self as unknown as {name?: string}).name?.startsWith('em-pthread');
