export class CuaError extends Error {
    code;
    details;
    constructor(code, message, details) {
        super(`[${code}] ${message}`);
        this.name = 'CuaError';
        this.code = code;
        this.details = details;
    }
}
export function formatError(err) {
    if (err instanceof CuaError) {
        const extra = err.details ? ` ${JSON.stringify(err.details)}` : '';
        return `${err.message}${extra}`;
    }
    if (err instanceof Error) {
        return err.stack || `${err.name}: ${err.message}`;
    }
    return String(err);
}
//# sourceMappingURL=errors.js.map