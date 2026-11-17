import vm from 'node:vm';
import { parentPort } from 'node:worker_threads';

if (!parentPort) {
  throw new Error('repl-worker must run inside a worker_threads Worker.');
}

const port = parentPort;

interface RpcPending {
  onResolve: (resJson: string) => void;
  onReject: (errJson: string) => void;
}

type WorkerInboundMessage =
  | {
      type: 'exec';
      execId: number;
      code: string;
      timeoutMs: number;
      initialStateJson?: string;
    }
  | {
      type: 'rpc-result';
      callId: number;
      ok: boolean;
      resultJson?: string;
      errorCode?: string;
      errorMessage?: string;
      errorDetailsJson?: string;
    }
  | {
      type: 'reset';
    };

type AwaitDoneCallback = (
  ok: boolean,
  hasValue: boolean,
  valuePayload: string,
  stateJson: string | undefined,
  errorText: string | undefined,
) => void;

type HostAwaitFn = (
  vmPromise: unknown,
  onDone: AwaitDoneCallback,
) => void;

let currentExecId = 0;
let nextCallId = 1;
const pendingRpc = new Map<number, RpcPending>();

function failAllPendingRpc(reason: string): void {
  const errJson = JSON.stringify({ code: 'Timeout', message: reason });
  for (const [id, entry] of pendingRpc) {
    pendingRpc.delete(id);
    try {
      entry.onReject(errJson);
    } catch {
      // Ignore worker teardown errors.
    }
  }
}

const SDK_METHODS = [
  'attach',
  'goto',
  'back',
  'forward',
  'reload',
  'snapshot',
  'screenshot',
  'click',
  'clickAt',
  'dblclick',
  'hover',
  'type',
  'press',
  'scroll',
  'drag',
  'select',
  'waitText',
  'waitUrl',
  'tabs',
  'newTab',
  'switchTab',
  'closeTab',
  'text',
  'url',
  'title',
] as const;

function createIsolatedVm(): {
  vmContext: vm.Context;
  hostAwait: HostAwaitFn;
  restoreState: (json: string) => void;
} {
  const bridge = {
    log: (level: string, line: string): void => {
      port.postMessage({ type: 'log', execId: currentExecId, level, line });
    },
    setTimer: (ms: number, cb: () => void): void => {
      const clamped = Math.max(0, Math.min(Number(ms) || 0, 30000));
      setTimeout(() => {
        try {
          cb();
        } catch {
          // Ignore callback errors if VM reset concurrently.
        }
      }, clamped);
    },
    parseUrl: (raw: string, base?: string): string => {
      try {
        const u = base !== undefined ? new URL(raw, base) : new URL(raw);
        return JSON.stringify({
          ok: true,
          href: u.href,
          origin: u.origin,
          protocol: u.protocol,
          username: u.username,
          password: u.password,
          host: u.host,
          hostname: u.hostname,
          port: u.port,
          pathname: u.pathname,
          search: u.search,
          hash: u.hash,
          entries: Array.from(u.searchParams.entries()),
        });
      } catch (err) {
        return JSON.stringify({
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    parseSearchParams: (init?: string): string => {
      try {
        const sp = new URLSearchParams(init ?? '');
        return JSON.stringify(Array.from(sp.entries()));
      } catch {
        return '[]';
      }
    },
    rpc: (
      method: string,
      argsJson: string,
      onResolve: (resJson: string) => void,
      onReject: (errJson: string) => void,
    ): void => {
      const callId = nextCallId++;
      pendingRpc.set(callId, { onResolve, onReject });
      port.postMessage({
        type: 'rpc',
        execId: currentExecId,
        callId,
        method,
        argsJson,
      });
    },
  };

  const sandbox: Record<string, unknown> = {
    __bootstrapBridge: bridge,
    __sdkMethods: SDK_METHODS,
  };

  const vmContext = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
  });

  const bootstrap = `
    (function () {
      'use strict';
      const bridge = globalThis.__bootstrapBridge;
      const sdkMethods = globalThis.__sdkMethods;
      delete globalThis.__bootstrapBridge;
      delete globalThis.__sdkMethods;

      const _Promise = Promise;
      const _PromiseThen = Promise.prototype.then;
      const _ReflectApply = Reflect.apply;
      const _Error = Error;
      const _TypeError = TypeError;
      const _JSONParse = JSON.parse;
      const _JSONStringify = JSON.stringify;
      const _ObjectFreeze = Object.freeze;
      const _ObjectAssign = Object.assign;
      const _ArrayIsArray = Array.isArray;
      const _String = String;
      const _Number = Number;
      const _Map = Map;

      const formatArg = (a) => {
        if (typeof a === 'string') return a;
        try {
          const s = _JSONStringify(a);
          return s === undefined ? _String(a) : s;
        } catch {
          return _String(a);
        }
      };

      const formatLogArgs = (args) => {
        const out = [];
        for (let i = 0; i < args.length; i++) {
          out.push(formatArg(args[i]));
        }
        return out.join(' ');
      };

      globalThis.state = {};

      globalThis.sleep = function sleep(ms) {
        return new _Promise((resolve) => {
          bridge.setTimer(_Number(ms) || 0, () => resolve());
        });
      };

      globalThis.console = _ObjectFreeze({
        log: (...args) => bridge.log('log', formatLogArgs(args)),
        info: (...args) => bridge.log('info', formatLogArgs(args)),
        warn: (...args) => bridge.log('warn', formatLogArgs(args)),
        error: (...args) => bridge.log('error', formatLogArgs(args)),
      });

      class CuaVmError extends _Error {
        constructor(code, message, details) {
          super(code ? '[' + code + '] ' + message : message);
          this.name = 'CuaError';
          this.code = code || 'Error';
          if (details !== undefined) this.details = details;
        }
      }

      class VmURLSearchParams {
        constructor(init) {
          this._entries = [];
          if (init && typeof init === 'object' && _ArrayIsArray(init)) {
            for (let i = 0; i < init.length; i++) {
              const pair = init[i];
              if (_ArrayIsArray(pair) && pair.length >= 2) {
                this._entries.push([_String(pair[0]), _String(pair[1])]);
              }
            }
          } else if (init !== undefined && init !== null) {
            const parsed = _JSONParse(bridge.parseSearchParams(_String(init)));
            for (let i = 0; i < parsed.length; i++) {
              this._entries.push([parsed[i][0], parsed[i][1]]);
            }
          }
        }
        get(name) {
          const k = _String(name);
          for (let i = 0; i < this._entries.length; i++) {
            if (this._entries[i][0] === k) return this._entries[i][1];
          }
          return null;
        }
        getAll(name) {
          const k = _String(name);
          const out = [];
          for (let i = 0; i < this._entries.length; i++) {
            if (this._entries[i][0] === k) out.push(this._entries[i][1]);
          }
          return out;
        }
        has(name) {
          const k = _String(name);
          for (let i = 0; i < this._entries.length; i++) {
            if (this._entries[i][0] === k) return true;
          }
          return false;
        }
        set(name, value) {
          const k = _String(name);
          const v = _String(value);
          let setDone = false;
          const next = [];
          for (let i = 0; i < this._entries.length; i++) {
            if (this._entries[i][0] === k) {
              if (!setDone) {
                next.push([k, v]);
                setDone = true;
              }
            } else {
              next.push(this._entries[i]);
            }
          }
          if (!setDone) next.push([k, v]);
          this._entries = next;
        }
        append(name, value) {
          this._entries.push([_String(name), _String(value)]);
        }
        delete(name) {
          const k = _String(name);
          this._entries = this._entries.filter((p) => p[0] !== k);
        }
        entries() {
          return this._entries.slice()[Symbol.iterator]();
        }
        [Symbol.iterator]() {
          return this.entries();
        }
        toString() {
          const parts = [];
          for (let i = 0; i < this._entries.length; i++) {
            parts.push(
              encodeURIComponent(this._entries[i][0]) +
                '=' +
                encodeURIComponent(this._entries[i][1]),
            );
          }
          return parts.join('&');
        }
      }

      class VmURL {
        constructor(raw, base) {
          const res = _JSONParse(
            bridge.parseUrl(_String(raw), base === undefined ? undefined : _String(base)),
          );
          if (!res.ok) {
            throw new _TypeError(res.message || 'Invalid URL');
          }
          this.href = res.href;
          this.origin = res.origin;
          this.protocol = res.protocol;
          this.username = res.username;
          this.password = res.password;
          this.host = res.host;
          this.hostname = res.hostname;
          this.port = res.port;
          this.pathname = res.pathname;
          this.search = res.search;
          this.hash = res.hash;
          this.searchParams = new VmURLSearchParams(res.entries);
        }
        toString() {
          return this.href;
        }
        toJSON() {
          return this.href;
        }
      }

      globalThis.URL = VmURL;
      globalThis.URLSearchParams = VmURLSearchParams;

      const cuaApi = {};
      for (let i = 0; i < sdkMethods.length; i++) {
        const methodName = sdkMethods[i];
        cuaApi[methodName] = (...args) =>
          new _Promise((resolve, reject) => {
            let encodedArgs;
            try {
              const normalized = [];
              for (let j = 0; j < args.length; j++) {
                normalized.push(args[j] === undefined ? null : args[j]);
              }
              encodedArgs = _JSONStringify(normalized);
            } catch (e) {
              reject(
                new CuaVmError(
                  'InvalidArgument',
                  'Arguments to cua.' + methodName + ' must be JSON-serializable: ' + _String(e),
                ),
              );
              return;
            }
            bridge.rpc(
              methodName,
              encodedArgs,
              (resJson) => {
                if (!resJson) {
                  resolve(undefined);
                  return;
                }
                try {
                  resolve(_JSONParse(resJson));
                } catch {
                  resolve(resJson);
                }
              },
              (errJson) => {
                try {
                  const err = _JSONParse(errJson);
                  const details = err.detailsJson ? _JSONParse(err.detailsJson) : undefined;
                  reject(new CuaVmError(err.code, err.message, details));
                } catch {
                  reject(new CuaVmError('Error', _String(errJson)));
                }
              },
            );
          });
      }
      globalThis.cua = _ObjectFreeze(cuaApi);

      const serializeValue = (val) => {
        if (val === undefined) return { hasValue: false, payload: '' };
        if (val === null || typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
          return { hasValue: true, payload: _JSONStringify(val) };
        }
        try {
          const s = _JSONStringify(val);
          if (s !== undefined) return { hasValue: true, payload: s };
        } catch {
          // Fall through to String conversion
        }
        return { hasValue: true, payload: _JSONStringify(_String(val)) };
      };

      const serializeStateSnapshot = () => {
        try {
          if (globalThis.state && typeof globalThis.state === 'object') {
            return _JSONStringify(globalThis.state);
          }
        } catch {
          // Ignore non-JSON-serializable state entries
        }
        return undefined;
      };

      const formatVmError = (err) => {
        if (err && typeof err === 'object') {
          if (err.name === 'CuaError' && typeof err.message === 'string') {
            const extra = err.details !== undefined ? ' ' + formatArg(err.details) : '';
            return err.message + extra;
          }
          if (typeof err.stack === 'string' && err.stack) return err.stack;
          if (typeof err.message === 'string') {
            return (err.name ? err.name + ': ' : '') + err.message;
          }
        }
        return _String(err);
      };

      return {
        restoreState(json) {
          try {
            const parsed = _JSONParse(json);
            if (parsed && typeof parsed === 'object' && !_ArrayIsArray(parsed)) {
              globalThis.state = _ObjectAssign({}, parsed);
            }
          } catch {
            // Ignore invalid state restore JSON.
          }
        },
        awaitPromise(vmPromise, onDone) {
          _ReflectApply(_PromiseThen, vmPromise, [
            (val) => {
              const ser = serializeValue(val);
              onDone(true, ser.hasValue, ser.payload, serializeStateSnapshot(), undefined);
            },
            (err) => {
              onDone(false, false, '', serializeStateSnapshot(), formatVmError(err));
            },
          ]);
        },
      };
    })()
  `;

  const bootstrapScript = new vm.Script(bootstrap, { filename: 'cua_repl_bootstrap.js' });
  const hooks = bootstrapScript.runInContext(vmContext) as {
    restoreState: (json: string) => void;
    awaitPromise: HostAwaitFn;
  };

  return {
    vmContext,
    hostAwait: hooks.awaitPromise,
    restoreState: hooks.restoreState,
  };
}

let vmEnv = createIsolatedVm();

port.on('message', (msg: WorkerInboundMessage) => {
  if (msg.type === 'reset') {
    failAllPendingRpc('REPL reset');
    currentExecId = 0;
    vmEnv = createIsolatedVm();
    port.postMessage({ type: 'reset-ack' });
    return;
  }

  if (msg.type === 'rpc-result') {
    const pending = pendingRpc.get(msg.callId);
    if (!pending) return;
    pendingRpc.delete(msg.callId);
    if (msg.ok) {
      pending.onResolve(msg.resultJson ?? '');
    } else {
      pending.onReject(
        JSON.stringify({
          code: msg.errorCode ?? 'Error',
          message: msg.errorMessage ?? 'RPC failed',
          detailsJson: msg.errorDetailsJson,
        }),
      );
    }
    return;
  }

  if (msg.type === 'exec') {
    currentExecId = msg.execId;
    if (msg.initialStateJson) {
      vmEnv.restoreState(msg.initialStateJson);
    }

    const wrapped = `'use strict';\n(async () => {\n${msg.code}\n})()`;
    try {
      const script = new vm.Script(wrapped, { filename: 'cua_repl_exec.js' });
      const vmPromise = script.runInContext(vmEnv.vmContext, {
        timeout: msg.timeoutMs,
      });

      vmEnv.hostAwait(vmPromise, (ok, hasValue, valuePayload, stateJson, errorText) => {
        if (currentExecId !== msg.execId) return;
        port.postMessage({
          type: 'exec-result',
          execId: msg.execId,
          ok,
          hasValue,
          valueJson: hasValue ? valuePayload : undefined,
          stateJson,
          error: errorText,
        });
      });
    } catch (err) {
      if (currentExecId !== msg.execId) return;
      const errText =
        err instanceof Error ? err.stack || `${err.name}: ${err.message}` : String(err);
      port.postMessage({
        type: 'exec-result',
        execId: msg.execId,
        ok: false,
        hasValue: false,
        error: errText,
      });
    }
  }
});
