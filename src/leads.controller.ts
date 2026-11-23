import { Controller, Get, Headers, HttpCode, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import { MISSING_CREDENTIALS, Settings } from "./config";
import { LeadDatabase } from "./db";
import { SyncService } from "./sync.service";

@Controller()
export class LeadsController {
  constructor(
    private readonly settings: Settings,
    private readonly database: LeadDatabase,
    private readonly syncService: SyncService,
  ) {}

  @Get("health")
  health() {
    return { ok: true };
  }

  @Get()
  root() {
    return this.database.status(this.settings);
  }

  @Get("status")
  status() {
    return this.database.status(this.settings);
  }

  @Post("sync")
  @HttpCode(200)
  async sync(@Headers("x-api-key") apiKey: string | undefined, @Res({ passthrough: true }) response: Response) {
    if (this.settings.apiKey && apiKey !== this.settings.apiKey) {
      response.status(401);
      return { error: "Invalid API key" };
    }
    if (!this.settings.credentialsReady) {
      response.status(400);
      return { error: MISSING_CREDENTIALS };
    }
    const result = await this.syncService.run();
    if (result.status === "busy") response.status(409);
    else if (result.status !== "ok") response.status(502);
    return result;
  }
}
