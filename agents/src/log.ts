export type Log = (message: string, fields?: Record<string, unknown>) => void;

export const consoleLog: Log = (message, fields) => console.log(message, ...(fields ? [fields] : []));
