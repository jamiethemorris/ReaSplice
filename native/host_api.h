#pragma once

// Version 0.7 uses distinct symbols so earlier pinned hosts can coexist safely.
// Bridge interface. Incoming UTF-8 JSON is valid only during the callback.
// Requests have {id:string, type:string, payload:object}.
// A bridge may reply later from any thread. Reply strings are copied immediately.
typedef void (*ReaSpliceMessageCallback)(const char *requestJSON);

#ifdef __cplusplus
extern "C" {
#endif
void ReaSpliceV07_SetMessageCallback(ReaSpliceMessageCallback callback);
void ReaSpliceV07_Reply(const char *requestID, const char *resultJSON, const char *error);
void *ReaSpliceV07_GetReaperAPI(const char *name);
#ifdef __cplusplus
}
#endif
