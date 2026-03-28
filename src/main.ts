import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Allow the React frontend to call this API
  app.enableCors({
    origin: "*",
    credentials: true,
  });
  // All API routes are under /api
  app.setGlobalPrefix('api');

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`\n🚀 Lead Capture API running on http://localhost:${port}/api`);

  // for testing
  // http://localhost:3001/api/webhook/debug-messages
  console.log(`   Webhook URL: http://localhost:${port}/api/webhook`);
  console.log(`   Leads API:   http://localhost:${port}/api/leads\n`);
}
bootstrap();
