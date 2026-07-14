export class UnauthorizedError extends Error {
  constructor(message = "Authentication required.") {
    super(message);
    this.name = "UnauthorizedError";
  }
}
export class ForbiddenError extends Error {
  constructor(message = "Admin access required.") {
    super(message);
    this.name = "ForbiddenError";
  }
}
export class EmailTakenError extends Error {
  constructor(email: string) {
    super(`An account already exists for ${email}.`);
    this.name = "EmailTakenError";
  }
}
export class InvalidCredentialsError extends Error {
  constructor() {
    super("Invalid email or password.");
    this.name = "InvalidCredentialsError";
  }
}
