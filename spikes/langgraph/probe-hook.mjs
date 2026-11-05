export async function load(url, context, next) {
  if (url.includes("node_modules")) {
    const m = url.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
    if (m) console.error("  loaded:", m[1]);
  }
  return next(url, context);
}
