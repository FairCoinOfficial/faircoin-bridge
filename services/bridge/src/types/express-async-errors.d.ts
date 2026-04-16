/**
 * Side-effect import: monkey-patches Express 4's Layer/Router to forward
 * rejected Promises returned from async route handlers to the next error
 * middleware. Upstream ships no types.
 */
declare module "express-async-errors";
