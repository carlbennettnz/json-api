export default function(resource, hook, registry, frameworkReq, frameworkRes) {
  let fn = registry[hook](resource.type);

  if (!fn) {
    return Promise.resolve([]);
  }

  return Promise.resolve(fn(resource, frameworkReq, frameworkRes));
}
