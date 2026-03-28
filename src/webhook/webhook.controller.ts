import { Controller, Get, Post, Query, Body, Res, Logger } from '@nestjs/common';
import { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { LeadsService } from '../leads/leads.service';
import axios from 'axios';
import { PollingService } from './polling.service';

@Controller('webhook')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  // Per-sender buffer so country-only messages arriving before the
  // phone message are not lost in real-time webhook events.
  private recentMessages = new Map<string, { text: string; ts: number; fbTs: number }[]>();

  constructor(
    private readonly config: ConfigService,
    private readonly leadsService: LeadsService,
    private readonly pollingService: PollingService,
  ) {
    // Clean stale buffer entries every 10 minutes
    setInterval(() => {
      const cutoff = Date.now() - 10 * 60 * 1000;
      for (const [key, msgs] of this.recentMessages.entries()) {
        const fresh = msgs.filter((m) => m.ts > cutoff);
        if (fresh.length === 0) this.recentMessages.delete(key);
        else this.recentMessages.set(key, fresh);
      }
    }, 10 * 60 * 1000);
  }

  // ── Facebook verification ─────────────────────────────────────
  @Get()
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    if (mode === 'subscribe' && token === this.config.get('META_VERIFY_TOKEN')) {
      this.logger.log('Webhook verified by Meta ✓');
      return res.status(200).send(challenge);
    }
    this.logger.error('Webhook verification failed — token mismatch');
    return res.status(403).send('Forbidden');
  }

  // ── Incoming message events ───────────────────────────────────
  @Post()
  async handleEvent(@Body() body: any) {
    if (body.object !== 'page') return { status: 'ignored' };
    for (const entry of body.entry ?? []) {
      for (const event of entry.messaging ?? []) {
        await this.processMessagingEvent(event);
      }
    }
    return { status: 'ok' };
  }

  // ── Real-time message processing ──────────────────────────────
  private async processMessagingEvent(event: any) {
    const text = event.message?.text?.trim();
    if (!text) return;

    const senderId: string = event.sender?.id;
    if (!senderId) return;

    // capturedAt = FB event timestamp (milliseconds epoch → Date)
    // Falls back to now() only if FB doesn't provide it.
    const capturedAt = event.timestamp
      ? new Date(event.timestamp)
      : new Date();

    // Buffer this message with both wall-clock ts (for TTL) and FB ts
    const buf = this.recentMessages.get(senderId) ?? [];
    buf.push({ text, ts: Date.now(), fbTs: capturedAt.getTime() });
    this.recentMessages.set(senderId, buf);

    const parsed = this.leadsService.parseMessage(text);

    if (!parsed) {
      // No phone — extract country and update any existing lead for this sender
      const country = this.leadsService.extractCountryOnly(text);
      if (country) {
        const updated = this.leadsService.updateCountryByIdentifiers(
          { facebookUserId: senderId, conversationId: senderId },
          country,
        );
        if (updated) {
          this.logger.log(`🌍 Real-time country update → ${updated.customerName}: ${country}`);
        }
      }
      return;
    }

    // Phone found — scan buffered messages for countries
    const allCountries: string[] = [];
    for (const { text: t } of buf) {
      const c = this.leadsService.extractCountryOnly(t);
      if (c && !allCountries.includes(c)) allCountries.push(c);
    }

    const country = parsed.country ?? allCountries[0] ?? 'Unknown';

    // Resolve customer name from Graph API
    let customerName = 'Unknown';
    try {
      const token = this.config.get('META_PAGE_ACCESS_TOKEN');
      const { data } = await axios.get(
        `https://graph.facebook.com/v19.0/${senderId}`,
        { params: { fields: 'name', access_token: token }, timeout: 4000 },
      );
      customerName = data.name ?? 'Unknown';
    } catch (err: any) {
      this.logger.warn(`Could not fetch name for ${senderId}: ${err.message}`);
    }

    const lead = this.leadsService.createLead({
      customerName,
      phone:           parsed.phone,
      country,
      facebookUserId:  senderId,
      conversationId:  senderId,
      messageSnippet:  parsed.messageSnippet ?? text.substring(0, 200),
      capturedAt,                   // ← Facebook event timestamp
    });

    if (lead) {
      this.logger.log(`✅ Real-time lead: ${customerName} | ${parsed.phone} | ${country} @ ${capturedAt.toISOString()}`);

      for (const c of allCountries) {
        if (c !== country) {
          this.leadsService.updateCountryByIdentifiers(
            { facebookUserId: senderId, conversationId: senderId }, c,
          );
        }
      }
    }
  }

  // ── Test / debug endpoints ────────────────────────────────────
  @Get('test-polling')
  async testPolling() {
    return this.pollingService.testPollingConnection();
  }

  @Get('polling-stats')
  async getPollingStats() {
    return {
      processedMessages: this.pollingService.getProcessedCount(),
      status: this.pollingService.getStatus(),
      timestamp: new Date().toISOString(),
    };
  }

  @Get('conversations')
  async getConversations(
    @Query('limit') limit = 10,
    @Query('since') sinceParam?: string,
  ) {
    const token  = this.config.get('META_PAGE_ACCESS_TOKEN');
    const pageId = this.config.get('META_PAGE_ID');
    if (!token || !pageId) {
      return { error: 'Missing META_PAGE_ACCESS_TOKEN or META_PAGE_ID' };
    }

    const since = sinceParam ? new Date(sinceParam) : undefined;
    const conversations = await this.pollingService.fetchAllConversationIds(token, pageId, since);

    const details = await Promise.all(
      conversations.slice(0, parseInt(limit.toString())).map(async (convId) => {
        try {
          const { data } = await axios.get(`https://graph.facebook.com/v19.0/${convId}`, {
            params: { fields: 'id,updated_time,participants{message_count}', access_token: token },
          });
          return data;
        } catch (err: any) {
          return { id: convId, error: err.message };
        }
      }),
    );

    return {
      success: true,
      total:   conversations.length,
      since:   since?.toISOString(),
      limit:   parseInt(limit.toString()),
      data:    details,
    };
  }

  @Get('debug-messages')
  async debugMessages() {
    const token  = this.config.get('META_PAGE_ACCESS_TOKEN');
    const pageId = this.config.get('META_PAGE_ID');

    const results: any = {
      pageId,
      tokenPreview: token ? token.substring(0, 20) + '...' : 'none',
      timestamp:    new Date().toISOString(),
      tests:        {} as any,
    };

    try {
      const page = await axios.get(`https://graph.facebook.com/v19.0/${pageId}`, {
        params: { fields: 'name,id,fan_count', access_token: token },
      });
      results.tests.pageInfo = { success: true, name: page.data.name, id: page.data.id };
    } catch (err: any) {
      results.tests.pageInfo = { success: false, error: err.response?.data?.error?.message || err.message };
    }

    try {
      const conv = await axios.get(`https://graph.facebook.com/v19.0/${pageId}/conversations`, {
        params: { fields: 'messages{message,from}', access_token: token, limit: 5 },
      });
      results.tests.conversations = {
        success:  true,
        count:    conv.data.data.length,
        messages: conv.data.data.map((c: any) => c.messages?.data?.length || 0),
      };
    } catch (err: any) {
      results.tests.conversations = { success: false, error: err.response?.data?.error?.message || err.message };
    }

    results.recommendations = [];
    if (!results.tests.pageInfo?.success)
      results.recommendations.push('❌ Cannot access page — check Page ID and Access Token');
    if (results.tests.conversations?.success && results.tests.conversations.count === 0)
      results.recommendations.push('💬 Send a private message to your page to test Messenger integration');

    return results;
  }
}
