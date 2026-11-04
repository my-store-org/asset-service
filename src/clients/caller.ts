import {
  createParamDecorator,
  ExecutionContext,
  Injectable,
  NestMiddleware,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { NextFunction, Request, Response } from "express";
import type { Client } from "./client.entity";
import { ClientsService } from "./clients.service";

type WithCaller = Request & { caller?: Client | null };

/**
 * Who is calling: the organization whose `x-client-key` and `x-client-secret`
 * came with the request, or null for a caller without them.
 *
 * Without a key a caller still works as before (my-store's browsers can't keep a
 * secret), but it can't see or touch any organization's files. Set
 * REQUIRE_CLIENT_KEY=true to refuse callers without a key altogether.
 */
@Injectable()
export class CallerMiddleware implements NestMiddleware {
  private readonly required: boolean;

  constructor(
    private readonly clients: ClientsService,
    config: ConfigService,
  ) {
    this.required = config.get("REQUIRE_CLIENT_KEY") === "true";
  }

  async use(req: WithCaller, _res: Response, next: NextFunction) {
    try {
      const key = req.header("x-client-key")?.trim();
      const secret = req.header("x-client-secret")?.trim();
      if (key || secret) {
        if (!key || !secret) throw new UnauthorizedException("Send both x-client-key and x-client-secret");
        req.caller = await this.clients.authenticate(key, secret);
        if (!req.caller && this.required) throw new UnauthorizedException("This client key is turned off");
      } else if (this.required) {
        throw new UnauthorizedException("A client key and secret are required");
      } else {
        req.caller = null;
      }
      next();
    } catch (err) {
      next(err);
    }
  }
}

/** The calling organization, or null for a caller without a key. */
export const Caller = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): Client | null =>
    ctx.switchToHttp().getRequest<WithCaller>().caller ?? null,
);
