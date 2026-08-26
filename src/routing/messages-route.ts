import type { ModelRecord } from '../models/ModelCatalog.js';
import type { SafeFailure } from '../translate/responses/types.js';

export type MessagesRoutePlan =
  | { kind: 'messages-passthrough'; modelId: string }
  | { kind: 'responses-translation'; modelId: string; model: ModelRecord }
  | { kind: 'client-error'; error: SafeFailure }
  | { kind: 'upstream-metadata-error'; error: SafeFailure };

/** Selects an exact advertised endpoint without changing the requested model id. */
export function planMessagesRoute(modelId: string, model: ModelRecord): MessagesRoutePlan {
  if (model.id !== modelId) {
    return {
      kind: 'upstream-metadata-error',
      error: {
        status: 502,
        type: 'api_error',
        message: `Model metadata did not match requested model "${modelId}".`,
      },
    };
  }

  if (model.supported_endpoints.includes('/v1/messages')) {
    return { kind: 'messages-passthrough', modelId };
  }

  if (model.supported_endpoints.includes('/responses')) {
    return { kind: 'responses-translation', modelId, model };
  }

  return {
    kind: 'client-error',
    error: {
      status: 400,
      type: 'invalid_request_error',
      message: `Model "${modelId}" has no supported Messages endpoint (${model.supported_endpoints.join(', ')}).`,
    },
  };
}