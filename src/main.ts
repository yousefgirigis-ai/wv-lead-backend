import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableCors({
    origin: "*",
    credentials: true,
  });

  app.setGlobalPrefix('api');

  // ✅ DUMMY ROOT ROUTE FOR RAILWAY TEST
  app.getHttpAdapter().get('/', (req, res) => {
    res.send({
      status: 'OK 🚀',
      message: 'NestJS API is running',
      test: '/api works',
      time: new Date().toISOString(),
    });
  });

  const port = process.env.PORT ?? 3000;
  await app.listen(port);

  console.log(`\n🚀 Lead Capture API running on port ${port}`);
  console.log(`   Test: http://localhost:${port}/`);
  console.log(`   API:  http://localhost:${port}/api`);
}
bootstrap();