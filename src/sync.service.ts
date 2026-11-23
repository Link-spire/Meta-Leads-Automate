import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { MISSING_CREDENTIALS, Settings } from "./config";
import { LeadDatabase } from "./db";
import { realClient, runSyncLocked } from "./sync";

@Injectable()
export class SyncService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SyncService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly settings: Settings,
    private readonly database: LeadDatabase,
  ) {}

  onApplicationBootstrap() {
    if (!this.settings.credentialsReady) {
      this.logger.warn(MISSING_CREDENTIALS);
      return;
    }
    if (this.settings.syncOnStart) void this.safeRun();
    if (this.settings.intervalMinutes > 0) {
      this.logger.log(`Syncing Meta leads every ${this.settings.intervalMinutes} minutes`);
      this.timer = setInterval(() => void this.safeRun(), this.settings.intervalMinutes * 60_000);
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  run() {
    return runSyncLocked(this.settings, this.database, realClient(this.settings));
  }

  private async safeRun() {
    try {
      const result = await this.run();
      this.logger.log(
        `Sync ${result.status}: forms=${result.forms_checked} fetched=${result.leads_fetched} saved=${result.leads_saved}`,
      );
      if (result.error) this.logger.error(result.error);
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : String(error));
    }
  }
}
