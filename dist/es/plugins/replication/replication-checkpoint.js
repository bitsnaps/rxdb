import { getSingleDocument, writeSingle } from '../../rx-storage-helper';
import { createRevision, flatClone, getDefaultRevision, now } from '../../util';
import { newRxError } from '../../rx-error';
import { wasLastWriteFromPullReplication } from './revision-flag';
import { getPrimaryKeyOfInternalDocument, INTERNAL_CONTEXT_REPLICATION_PRIMITIVES } from '../../rx-database-internal-store'; //
// things for the push-checkpoint
//

function _settle(pact, state, value) {
  if (!pact.s) {
    if (value instanceof _Pact) {
      if (value.s) {
        if (state & 1) {
          state = value.s;
        }

        value = value.v;
      } else {
        value.o = _settle.bind(null, pact, state);
        return;
      }
    }

    if (value && value.then) {
      value.then(_settle.bind(null, pact, state), _settle.bind(null, pact, 2));
      return;
    }

    pact.s = state;
    pact.v = value;
    const observer = pact.o;

    if (observer) {
      observer(pact);
    }
  }
}

var _Pact = /*#__PURE__*/function () {
  function _Pact() {}

  _Pact.prototype.then = function (onFulfilled, onRejected) {
    var result = new _Pact();
    var state = this.s;

    if (state) {
      var callback = state & 1 ? onFulfilled : onRejected;

      if (callback) {
        try {
          _settle(result, 1, callback(this.v));
        } catch (e) {
          _settle(result, 2, e);
        }

        return result;
      } else {
        return this;
      }
    }

    this.o = function (_this) {
      try {
        var value = _this.v;

        if (_this.s & 1) {
          _settle(result, 1, onFulfilled ? onFulfilled(value) : value);
        } else if (onRejected) {
          _settle(result, 1, onRejected(value));
        } else {
          _settle(result, 2, value);
        }
      } catch (e) {
        _settle(result, 2, e);
      }
    };

    return result;
  };

  return _Pact;
}();

function _isSettledPact(thenable) {
  return thenable instanceof _Pact && thenable.s & 1;
}

function _for(test, update, body) {
  var stage;

  for (;;) {
    var shouldContinue = test();

    if (_isSettledPact(shouldContinue)) {
      shouldContinue = shouldContinue.v;
    }

    if (!shouldContinue) {
      return result;
    }

    if (shouldContinue.then) {
      stage = 0;
      break;
    }

    var result = body();

    if (result && result.then) {
      if (_isSettledPact(result)) {
        result = result.s;
      } else {
        stage = 1;
        break;
      }
    }

    if (update) {
      var updateValue = update();

      if (updateValue && updateValue.then && !_isSettledPact(updateValue)) {
        stage = 2;
        break;
      }
    }
  }

  var pact = new _Pact();

  var reject = _settle.bind(null, pact, 2);

  (stage === 0 ? shouldContinue.then(_resumeAfterTest) : stage === 1 ? result.then(_resumeAfterBody) : updateValue.then(_resumeAfterUpdate)).then(void 0, reject);
  return pact;

  function _resumeAfterBody(value) {
    result = value;

    do {
      if (update) {
        updateValue = update();

        if (updateValue && updateValue.then && !_isSettledPact(updateValue)) {
          updateValue.then(_resumeAfterUpdate).then(void 0, reject);
          return;
        }
      }

      shouldContinue = test();

      if (!shouldContinue || _isSettledPact(shouldContinue) && !shouldContinue.v) {
        _settle(pact, 1, result);

        return;
      }

      if (shouldContinue.then) {
        shouldContinue.then(_resumeAfterTest).then(void 0, reject);
        return;
      }

      result = body();

      if (_isSettledPact(result)) {
        result = result.v;
      }
    } while (!result || !result.then);

    result.then(_resumeAfterBody).then(void 0, reject);
  }

  function _resumeAfterTest(shouldContinue) {
    if (shouldContinue) {
      result = body();

      if (result && result.then) {
        result.then(_resumeAfterBody).then(void 0, reject);
      } else {
        _resumeAfterBody(result);
      }
    } else {
      _settle(pact, 1, result);
    }
  }

  function _resumeAfterUpdate() {
    if (shouldContinue = test()) {
      if (shouldContinue.then) {
        shouldContinue.then(_resumeAfterTest).then(void 0, reject);
      } else {
        _resumeAfterTest(shouldContinue);
      }
    } else {
      _settle(pact, 1, result);
    }
  }
}

export var setLastPullDocument = function setLastPullDocument(collection, replicationIdentifierHash, lastPulledDoc) {
  try {
    var pullCheckpointId = getPrimaryKeyOfInternalDocument(pullLastDocumentKey(replicationIdentifierHash), INTERNAL_CONTEXT_REPLICATION_PRIMITIVES);
    return Promise.resolve(getSingleDocument(collection.database.internalStore, pullCheckpointId)).then(function (lastPullCheckpointDoc) {
      if (!lastPullCheckpointDoc) {
        var insertData = {
          id: pullCheckpointId,
          key: pullLastDocumentKey(replicationIdentifierHash),
          context: INTERNAL_CONTEXT_REPLICATION_PRIMITIVES,
          data: {
            lastPulledDoc: lastPulledDoc
          },
          _meta: {
            lwt: now()
          },
          _rev: getDefaultRevision(),
          _deleted: false,
          _attachments: {}
        };
        insertData._rev = createRevision(insertData);
        return writeSingle(collection.database.internalStore, {
          document: insertData
        });
      } else {
        var newDoc = flatClone(lastPullCheckpointDoc);
        newDoc.data = {
          lastPulledDoc: lastPulledDoc
        };
        newDoc._rev = createRevision(newDoc, lastPullCheckpointDoc);
        newDoc._meta = {
          lwt: now()
        };
        return writeSingle(collection.database.internalStore, {
          previous: lastPullCheckpointDoc,
          document: newDoc
        });
      }
    });
  } catch (e) {
    return Promise.reject(e);
  }
};
export var getChangesSinceLastPushSequence = function getChangesSinceLastPushSequence(collection, replicationIdentifierHash,
/**
 * A function that returns true
 * when the underlaying RxReplication is stopped.
 * So that we do not run requests against a close RxStorageInstance.
 */
isStopped) {
  try {
    var _arguments2 = arguments;
    var batchSize = _arguments2.length > 3 && _arguments2[3] !== undefined ? _arguments2[3] : 10;
    return Promise.resolve(getLastPushSequence(collection, replicationIdentifierHash)).then(function (lastPushSequence) {
      var _interrupt = false;

      function _temp2() {
        return {
          changedDocIds: changedDocIds,
          changedDocs: changedDocs,
          lastSequence: lastSequence
        };
      }

      var retry = true;
      var lastSequence = lastPushSequence;
      var changedDocs = new Map();
      var changedDocIds = new Set();
      /**
       * it can happen that all docs in the batch
       * do not have to be replicated.
       * Then we have to continue grapping the feed
       * until we reach the end of it
       */

      var _temp = _for(function () {
        return !_interrupt && !!retry && !isStopped();
      }, void 0, function () {
        return Promise.resolve(collection.storageInstance.getChangedDocuments({
          sinceSequence: lastPushSequence,
          limit: batchSize,
          direction: 'after'
        })).then(function (changesResults) {
          lastSequence = changesResults.lastSequence; // optimisation shortcut, do not proceed if there are no changed documents

          if (changesResults.changedDocuments.length === 0) {
            retry = false;
            return;
          }

          var docIds = changesResults.changedDocuments.map(function (row) {
            return row.id;
          });

          if (isStopped()) {
            _interrupt = true;
            return;
          }

          return Promise.resolve(collection.storageInstance.findDocumentsById(docIds, true)).then(function (docs) {
            changesResults.changedDocuments.forEach(function (row) {
              var id = row.id;

              if (changedDocs.has(id)) {
                return;
              }

              var changedDoc = docs[id];

              if (!changedDoc) {
                throw newRxError('SNH', {
                  args: {
                    docs: docs,
                    docIds: docIds
                  }
                });
              }
              /**
               * filter out changes with revisions resulting from the pull-stream
               * so that they will not be upstreamed again
               */


              if (wasLastWriteFromPullReplication(replicationIdentifierHash, changedDoc)) {
                return false;
              }

              changedDocIds.add(id);
              changedDocs.set(id, {
                id: id,
                doc: changedDoc,
                sequence: row.sequence
              });
            });

            if (changedDocs.size < batchSize && changesResults.changedDocuments.length === batchSize) {
              // no pushable docs found but also not reached the end -> re-run
              lastPushSequence = lastSequence;
              retry = true;
            } else {
              retry = false;
            }
          });
        });
      });

      return _temp && _temp.then ? _temp.then(_temp2) : _temp2(_temp);
    });
  } catch (e) {
    return Promise.reject(e);
  }
}; //
// things for pull-checkpoint
//

export var setLastPushSequence = function setLastPushSequence(collection, replicationIdentifierHash, sequence) {
  try {
    var docId = getPrimaryKeyOfInternalDocument(pushSequenceDocumentKey(replicationIdentifierHash), INTERNAL_CONTEXT_REPLICATION_PRIMITIVES);
    return Promise.resolve(getSingleDocument(collection.database.internalStore, docId)).then(function (doc) {
      if (!doc) {
        var insertData = {
          id: docId,
          key: pushSequenceDocumentKey(replicationIdentifierHash),
          context: INTERNAL_CONTEXT_REPLICATION_PRIMITIVES,
          data: {
            lastPushSequence: sequence
          },
          _deleted: false,
          _meta: {
            lwt: now()
          },
          _rev: getDefaultRevision(),
          _attachments: {}
        };
        insertData._rev = createRevision(insertData);
        return Promise.resolve(writeSingle(collection.database.internalStore, {
          document: insertData
        }));
      } else {
        var newDoc = flatClone(doc);
        newDoc.data = {
          lastPushSequence: sequence
        };
        var docData = {
          id: docId,
          key: pushSequenceDocumentKey(replicationIdentifierHash),
          context: INTERNAL_CONTEXT_REPLICATION_PRIMITIVES,
          data: {
            lastPushSequence: sequence
          },
          _meta: {
            lwt: now()
          },
          _rev: getDefaultRevision(),
          _deleted: false,
          _attachments: {}
        };
        docData._rev = createRevision(docData, doc);
        return Promise.resolve(writeSingle(collection.database.internalStore, {
          previous: doc,
          document: docData
        }));
      }
    });
  } catch (e) {
    return Promise.reject(e);
  }
};

var pushSequenceDocumentKey = function pushSequenceDocumentKey(replicationIdentifierHash) {
  return 'replication-checkpoint-push-' + replicationIdentifierHash;
};

var pullLastDocumentKey = function pullLastDocumentKey(replicationIdentifierHash) {
  return 'replication-checkpoint-pull-' + replicationIdentifierHash;
};
/**
 * Get the last push checkpoint
 */


export function getLastPushSequence(collection, replicationIdentifierHash) {
  return getSingleDocument(collection.database.internalStore, getPrimaryKeyOfInternalDocument(pushSequenceDocumentKey(replicationIdentifierHash), INTERNAL_CONTEXT_REPLICATION_PRIMITIVES)).then(function (doc) {
    if (!doc) {
      return 0;
    } else {
      return doc.data.lastPushSequence;
    }
  });
}
export function getLastPullDocument(collection, replicationIdentifierHash) {
  return getSingleDocument(collection.database.internalStore, getPrimaryKeyOfInternalDocument(pullLastDocumentKey(replicationIdentifierHash), INTERNAL_CONTEXT_REPLICATION_PRIMITIVES)).then(function (lastPullCheckpoint) {
    if (!lastPullCheckpoint) {
      return null;
    } else {
      return lastPullCheckpoint.data.lastPulledDoc;
    }
  });
}
//# sourceMappingURL=replication-checkpoint.js.map