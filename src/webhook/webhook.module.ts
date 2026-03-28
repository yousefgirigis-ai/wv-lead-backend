import { Module } from '@nestjs/common';
import { WebhookController } from './webhook.controller';
import { PollingService } from './polling.service';
import { LeadsModule } from '../leads/leads.module';

@Module({
  imports: [LeadsModule],
  controllers: [WebhookController],
  providers: [PollingService],
    exports: [PollingService],
})
export class WebhookModule {}
