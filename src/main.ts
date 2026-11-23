import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { loadSettings } from "./config";

async function bootstrap() {
  const settings = loadSettings();
  const app = await NestFactory.create(AppModule);
  await app.listen(settings.port, settings.host);
  Logger.log(`Listening on http://${settings.host}:${settings.port}`, "Bootstrap");
}

bootstrap();
