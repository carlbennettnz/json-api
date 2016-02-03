export default function(type, resource, hook, registry, frameworkReq, frameworkRes) {
  let fn = registry[hook](type);

  if (!fn) {
    return Promise.resolve([]);
  }

  return Promise.resolve(fn(resource, frameworkReq, frameworkRes));
}
