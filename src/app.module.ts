import { Module } from "@nestjs/common";
import { LeadDatabase } from "./db";
import { LeadsController } from "./leads.controller";
import { loadSettings, Settings } from "./config";
import { SyncService } from "./sync.service";

@Module({
  controllers: [LeadsController],
  providers: [
    { provide: Settings, useFactory: () => loadSettings() },
    {
      provide: LeadDatabase,
      useFactory: async (settings: Settings) => {
        if (settings.mysql) {
          const { MysqlLeadDatabase } = await import("./mysql-db");
          return MysqlLeadDatabase.open(settings.mysql);
        }
        return LeadDatabase.open(settings.databasePath);
      },
      inject: [Settings],
    },
    SyncService,
  ],
})
export class AppModule {}
