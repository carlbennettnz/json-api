import {
  AdapterInstance,
  QueryReturning
} from '../db-adapters/AdapterInterface';

import ResourceTypeRegistry from '../ResourceTypeRegistry';

import Query from '../types/Query/Query';
import CreateQuery from '../types/Query/CreateQuery';
import FindQuery from '../types/Query/FindQuery';
import DeleteQuery from '../types/Query/DeleteQuery';
import UpdateQuery from '../types/Query/UpdateQuery';
import AddToRelationshipQuery from '../types/Query/AddToRelationshipQuery';
import RemoveFromRelationshipQuery from '../types/Query/RemoveFromRelationshipQuery';
import WithCriteriaQuery from '../types/Query/WithCriteriaQuery';

import { invalidQueryParamValue } from '../util/errors';

export default function runQuery(
  registry: ResourceTypeRegistry,
  query: Query
): Promise<QueryReturning> {
  let finalizedQuery = query;

  if (query instanceof WithCriteriaQuery) {
    enforceMaxLimit(registry, query);
    finalizedQuery = applyDefaultLimit(registry, query);
  }

  // Adapter cannot be null as long as the type exists
  // tslint:disable-next-line no-non-null-assertion
  const adapter = registry.dbAdapter(finalizedQuery.type)!;

  return dispatchQuery(adapter, finalizedQuery);
}

function enforceMaxLimit(
  registry: ResourceTypeRegistry,
  {query}: WithCriteriaQuery
): void {
  const { type, criteria, ignoreLimitMax } = query;
  const { maxPageSize } = registry.pagination(type);

  if (!ignoreLimitMax && maxPageSize != null && criteria.limit != null && criteria.limit > maxPageSize) {
    throw invalidQueryParamValue({
      detail: `Must use a smaller limit per page.`,
      source: { parameter: "page[limit]" }
    });
  }
}

function applyDefaultLimit<T extends WithCriteriaQuery>(registry: ResourceTypeRegistry, query: T): T {
  const { defaultPageSize } = registry.pagination(query.type);

  return query.limit == null && defaultPageSize != null
    ? query.withLimit(defaultPageSize)
    : query;
}

function dispatchQuery(adapter: AdapterInstance<any>, query: Query): Promise<QueryReturning> {
  const method = (
    (query instanceof CreateQuery && adapter.create) ||
    (query instanceof FindQuery && adapter.find) ||
    (query instanceof DeleteQuery && adapter.delete) ||
    (query instanceof UpdateQuery && adapter.update) ||
    (query instanceof AddToRelationshipQuery && adapter.addToRelationship) ||
    (query instanceof RemoveFromRelationshipQuery && adapter.removeFromRelationship)
  );

  if (!method) {
    throw new Error("Unexpected query type.");
  }

  return Promise.resolve(
    method.call(adapter, query)
  );
}
