export class AgentJobError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "AgentJobError";
    this.code = code;
    this.status = status;
  }
}
