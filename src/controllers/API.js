import co from "co";

import Response from "../types/HTTP/Response";
import Document from "../types/Document";
import Resource from "../types/Resource";
import Collection from "../types/Collection";
import APIError from "../types/APIError";

import * as requestValidators from "../steps/http/validate-request";
import negotiateContentType from "../steps/http/content-negotiation/negotiate-content-type";
import validateContentType from "../steps/http/content-negotiation/validate-content-type";


import labelToIds from "../steps/pre-query/label-to-ids";
import parseRequestPrimary from "../steps/pre-query/parse-request-primary";
import validateRequestDocument from "../steps/pre-query/validate-document";
import validateRequestResources from "../steps/pre-query/validate-resources";
import applyTransform from "../steps/apply-transform";

import doGET from "../steps/do-query/do-get";
import doPOST from "../steps/do-query/do-post";
import doPATCH from "../steps/do-query/do-patch";
import doDELETE from "../steps/do-query/do-delete";

let supportedExt = [];

// We have to globally patch Promise for co to work, even though global patches
// are suboptimal. See https://github.com/ethanresnick/json-api/issues/47
// We use eval so that the runtime transformer doesn't replace our check for an
// existing Promise with an invocation of the polyfill.
/*eslint-disable no-eval */
GLOBAL.Promise = eval("typeof Promise !== 'undefined' ? Promise : undefined") ||
  require("babel-runtime/core-js/promise").default;
/*eslint-enable no-eval */

class APIController {
  constructor(registry) {
    this.registry = registry;
  }

  /**
   * @param {Request} request The Request this controller will use to generate
   *    the Response.
   * @param {Object} frameworkReq This should be the request object generated by
   *    the framework that you're using. But, really, it can be absolutely
   *    anything, as this controller won't use it for anything except passing it
   *    to user-provided functions that it calls (like transforms and id mappers).
   * @param {Object} frameworkRes Theoretically, the response objcet generated
   *     by your http framework but, like with frameworkReq, it can be anything.
   */
  handle(request, frameworkReq, frameworkRes) {
    let response = new Response();
    let registry = this.registry;

    // Kick off the chain for generating the response.
    return co(function*() {
      try {
        // check that a valid method is in use
        yield requestValidators.checkMethod(request);

        // throw if the body is supposed to be present but isn't (or vice-versa).
        yield requestValidators.checkBodyExistence(request);

        // Try to negotiate the content type (may fail, and we may need to
        // deviate from the negotiated value if we have to return an error
        // body, rather than our expected response).
        response.contentType = yield negotiateContentType(
          request.accepts, ["application/vnd.api+json"]
        );

        // No matter what, though, we're varying on Accept. See:
        // https://github.com/ethanresnick/json-api/issues/22
        response.headers.vary = "Accept";

        // If the type requested in the endpoint hasn't been registered, we 404.
        if(!registry.hasType(request.type)) {
          throw new APIError(404, undefined, `${request.type} is not a valid type.`);
        }

        // If the request has a body, validate it and parse its resources.
        if(request.hasBody) {
          yield validateContentType(request, supportedExt);
          yield validateRequestDocument(request.body);

          let parsedPrimary = yield parseRequestPrimary(
            request.body.data, request.aboutRelationship
          );

          // validate the request's resources.
          if(!request.aboutRelationship) {
            yield validateRequestResources(request.type, parsedPrimary, registry);
          }

          request.primary = yield applyTransform(
            parsedPrimary, "beforeSave", registry, frameworkReq, frameworkRes
          );
        }

        // Map label to idOrIds, if applicable.
        if(request.idOrIds && request.allowLabel) {
          let mappedLabel = yield labelToIds(
            request.type, request.idOrIds, registry, frameworkReq
          );

          // set the idOrIds on the request context
          request.idOrIds = mappedLabel;

          // if our new ids are null/undefined or an empty array, we can set
          // the primary resources too! (Note: one could argue that we should
          // 404 rather than return null when the label matches no ids.)
          let mappedIsEmptyArray = Array.isArray(mappedLabel) && !mappedLabel.length;

          if(mappedLabel === null || mappedLabel === undefined || mappedIsEmptyArray) {
            response.primary = (mappedLabel) ? new Collection() : null;
          }
        }

        if (request.method === "delete") {
          let toTransform;

          if (Array.isArray(request.idOrIds)) {
            toTransform = new Collection(
              request.idOrIds.map((id) => new Resource(request.type, id))
            );
          }

          else if (typeof request.idOrIds === "string") {
            toTransform = new Resource(request.type, request.idOrIds);
          }

          yield applyTransform(
            toTransform, "beforeDelete", registry, frameworkReq, frameworkRes
          );
        }

        // Actually fulfill the request!
        // If we've already populated the primary resources, which is possible
        // because the label may have mapped to no id(s), we don't need to query.
        if(typeof response.primary === "undefined") {
          switch(request.method) {
            case "get":
              yield doGET(request, response, registry);
              break;

            case "post":
              yield doPOST(request, response, registry);
              break;

            case "patch":
              yield doPATCH(request, response, registry);
              break;

            case "delete":
              yield doDELETE(request, response, registry);
          }
        }
      }

      // Add errors to the response converting them, if necessary, to
      // APIError instances first. Might be needed if, e.g., the error was
      // unexpected (and so uncaught and not transformed) in one of prior steps
      // or the user couldn't throw an APIError for compatibility with other code.
      catch (errors) {
        let errorsArr = Array.isArray(errors) ? errors : [errors];
        let apiErrors = errorsArr.map(APIError.fromError);

        // Leave the error response's content type as JSON if we negotiated
        // for that, but otherwise force it to JSON API, since that's the only
        // other error format we know how to generate.
        if(response.contentType !== "application/json") {
          response.contentType = "application/vnd.api+json";
        }

        // Set the other key fields on the response
        response.errors = response.errors.concat(apiErrors);
        //console.log("API CONTROLLER ERRORS", errorsArr[0], errorsArr[0].stack);
      }

      // If we have errors, which could have come from prior steps not just
      // throwing, return here and don't bother with transforms.
      if(response.errors.length) {
        response.status = pickStatus(response.errors.map((v) => Number(v.status)));
        response.body = new Document(response.errors).get(true);
        return response;
      }

      // apply transforms pre-send
      response.primary = yield applyTransform(
        response.primary, "beforeRender", registry, frameworkReq, frameworkRes
      );

      response.included = yield applyTransform(
        response.included, "beforeRender", registry, frameworkReq, frameworkRes
      );

      if(response.status !== 204) {
        response.body = new Document(
          response.primary, response.included,
          undefined, registry.urlTemplates(), request.uri
        ).get(true);
      }

      return response;
    });
  }

  /**
   * Builds a response from errors. Allows errors that occur outside of the
   * library to be handled and returned in JSON API-compiant fashion.
   *
   * @param {Error|APIError|Error[]|APIError[]} errors Error or array of errors
   * @param {string} requestAccepts Request's Accepts header
   */
  static responseFromExternalError(errors, requestAccepts) {
    let response = new Response();

    // Convert to array
    response.errors = Array.isArray(errors) ? errors : [errors];

    // Convert Errors to APIErrors
    response.errors = response.errors.map(APIError.fromError.bind(APIError));

    response.status = pickStatus(response.errors.map((v) => Number(v.status)));
    response.body = new Document(response.errors).get(true);

    return negotiateContentType(requestAccepts, ["application/vnd.api+json"])
      .then((contentType) => {
        response.contentType = (contentType.toLowerCase() === "application/json")
          ? contentType : "application/vnd.api+json";
        return response;
      }, () => {
        // if we couldn't find any acceptable content-type,
        // just ignore the accept header, as http allows.
        response.contentType = "application/vnd.api+json";
        return response;
      }
    );
  }
}

APIController.supportedExt = supportedExt;

export default APIController;

/**
 * Returns the status code that best represents a set of error statuses.
 */
function pickStatus(errStatuses) {
  return errStatuses[0];
}
