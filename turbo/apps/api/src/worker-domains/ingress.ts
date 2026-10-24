interface Bindings {
  readonly API: {
    fetch(request: Request): Promise<Response>;
  };
}

// Keep authentication, billing, routing, and response ownership in the API.
// Passing the native objects through preserves streaming without buffering.
export default {
  fetch(request: Request, bindings: Bindings): Promise<Response> {
    return bindings.API.fetch(request);
  },
};
