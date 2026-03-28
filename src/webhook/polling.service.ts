import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { LeadsService } from '../leads/leads.service';

const DEFAULT_WINDOW_HOURS = 24;

@Injectable()
export class PollingService {
  private readonly logger = new Logger(PollingService.name);

  // Tracks FB message IDs we have already processed — prevents re-processing
  // the same message across poll cycles.
  private processedMessageIds = new Set<string>();

  private consecutiveErrors = 0;
  private lastPollTime: Date | null = null;
  private totalProcessed = 0;
  private isRunning = false;

  constructor(
    private readonly config: ConfigService,
    private readonly leadsService: LeadsService,
  ) {}

  @Cron('*/30 * * * * *')
  async pollMessages() {
    const token  = this.config.get('META_PAGE_ACCESS_TOKEN');
    const pageId = this.config.get('META_PAGE_ID');
    if (!token || !pageId || token === 'paste_your_token_here') return;
    if (this.consecutiveErrors > 10) return;
    if (this.isRunning) { this.logger.debug('Poll running — skipping tick'); return; }

    this.isRunning    = true;
    this.lastPollTime = new Date();

    try {
      const windowHours =
        parseInt(this.config.get('POLL_WINDOW_HOURS') ?? '') || DEFAULT_WINDOW_HOURS;
      const since = new Date();
      since.setHours(since.getHours() - windowHours);

      const conversationIds = await this.fetchAllConversationIds(token, pageId, since);
      if (!conversationIds.length) {
        this.logger.debug(`No conversations in last ${windowHours}h`);
        return;
      }

      this.logger.log(`Found ${conversationIds.length} conversation(s) — fetching in parallel`);

      // Fetch windowed messages per conversation in parallel
      const messageArrays = await Promise.all(
        conversationIds.map((id) => this.fetchMessagesInConversation(token, pageId, id, since)),
      );

      const totalMsgs = messageArrays.reduce((s, a) => s + a.length, 0);
      this.logger.log(`Fetched ${totalMsgs} message(s) across ${conversationIds.length} conversation(s)`);

      let totalNew = 0, totalCountryUpdates = 0;
      for (let i = 0; i < conversationIds.length; i++) {
        if (!messageArrays[i].length) continue;
        const { newLeads, countryUpdates } = await this.processConversation(
          messageArrays[i], pageId, token, conversationIds[i],
        );
        totalNew += newLeads;
        totalCountryUpdates += countryUpdates;
      }

      if (totalNew > 0 || totalCountryUpdates > 0) {
        this.logger.log(`Cycle done: ${totalNew} new lead(s), ${totalCountryUpdates} country update(s)`);
      }
      this.consecutiveErrors = 0;
    } catch (err: any) {
      this.consecutiveErrors++;
      if (this.consecutiveErrors <= 3) this.logger.error(`Poll error: ${err.message}`);
    } finally {
      this.isRunning = false;
    }
  }

  // PUBLIC — called by WebhookController /conversations endpoint
  async fetchAllConversationIds(token: string, pageId: string, since?: Date): Promise<string[]> {
    const ids: string[] = [];
    let url: string | null = `https://graph.facebook.com/v19.0/${pageId}/conversations`;
    let params: Record<string, any> = {
      fields: 'id,updated_time',
      access_token: token,
      limit: 25,
    };

    while (url) {
      const { data } = await axios.get(url, { params, timeout: 10000 });
      let stop = false;
      for (const conv of data.data ?? []) {
        if (since && new Date(conv.updated_time) < since) { stop = true; break; }
        ids.push(conv.id);
      }
      url = (!stop && data.paging?.next) ? data.paging.next : null;
      params = {};
    }
    return ids;
  }

  // PUBLIC — called by WebhookController and testPollingConnection
  async fetchMessagesInConversation(
    token: string,
    pageId: string,
    conversationId: string,
    since?: Date,
  ): Promise<any[]> {
    const results: any[] = [];
    let url: string | null = `https://graph.facebook.com/v19.0/${conversationId}/messages`;
    let params: Record<string, any> = {
      fields: 'id,message,created_time,from',
      access_token: token,
      limit: 25,
    };

    while (url) {
      const { data } = await axios.get(url, { params, timeout: 8000 });
      let stop = false;
      for (const msg of data.data ?? []) {
        if (since && new Date(msg.created_time) < since) { stop = true; break; }
        // Only keep messages FROM the customer (not the page itself)
        if (msg.from?.id !== pageId) results.push({ ...msg, conversation_id: conversationId });
      }
      url = (!stop && data.paging?.next) ? data.paging.next : null;
      params = {};
    }
    return results;
  }

  // ── Process ONE conversation ───────────────────────────────────
  //
  // Key behaviours:
  //  • capturedAt  = msg.created_time from Facebook (not server wall-clock)
  //  • Dedup       = by phone number in LeadsService in-memory store
  //  • No DB       = everything lives in LeadsService.store for this process lifetime
  //  • Sort oldest-first before processing so country-before-phone works
  //  • Pre-scan all messages in conversation for country hints
  //  • Full history fetch (no window) for country pre-scan
  //
  async processConversation(
    windowMessages: any[],
    pageId: string,
    token: string,
    conversationId: string,
  ): Promise<{ newLeads: number; countryUpdates: number }> {
    let newLeads = 0, countryUpdates = 0;

    // Sort oldest → newest so we process phone-first, then country updates
    const sorted = [...windowMessages].sort(
      (a, b) => new Date(a.created_time).getTime() - new Date(b.created_time).getTime(),
    );

    // Fetch FULL conversation history (no time limit) for country pre-scan
    // so a country sent days ago is still captured
    let allConvMessages = sorted;
    try {
      const fullHistory = await this.fetchMessagesInConversation(token, pageId, conversationId);
      if (fullHistory.length > sorted.length) allConvMessages = fullHistory;
    } catch { /* non-critical */ }

    // Pre-scan ALL messages in this conversation for countries
    const allCountries: string[] = [];
    for (const msg of allConvMessages) {
      const c = this.leadsService.extractCountryOnly(msg.message ?? '');
      if (c && !allCountries.includes(c)) allCountries.push(c);
    }

    const senderId = sorted.find((m) => m.from?.id)?.from?.id;

    // Name resolution with fallbacks (Graph API → participants list)
    let resolvedName: string | null = null;
    const getCustomerName = async (fromName?: string): Promise<string> => {
      if (resolvedName) return resolvedName;
      if (fromName)   { resolvedName = fromName; return fromName; }
      if (!senderId)    return 'Unknown';

      try {
        const { data } = await axios.get(`https://graph.facebook.com/v19.0/${senderId}`, {
          params: { fields: 'name', access_token: token }, timeout: 4000,
        });
        if (data.name) { resolvedName = data.name; return data.name; }
      } catch { /* privacy-restricted */ }

      try {
        const { data } = await axios.get(`https://graph.facebook.com/v19.0/${conversationId}`, {
          params: { fields: 'participants', access_token: token }, timeout: 4000,
        });
        const participant = (data.participants?.data ?? []).find((p: any) => p.id !== pageId);
        if (participant?.name) { resolvedName = participant.name; return participant.name; }
      } catch { /* ignore */ }

      resolvedName = 'Unknown';
      return 'Unknown';
    };

    for (const msg of sorted) {
      try {
        if (this.processedMessageIds.has(msg.id)) continue;
        this.processedMessageIds.add(msg.id);

        const text = (msg.message ?? '').trim();
        if (!text) continue;

        // capturedAt comes DIRECTLY from Facebook's created_time
        const capturedAt = new Date(msg.created_time);

        const parsed = this.leadsService.parseMessage(text);

        if (!parsed) {
          // No phone — try to update country on an existing lead
          const country = this.leadsService.extractCountryOnly(text);
          if (country && senderId) {
            const updated = this.leadsService.updateCountryByIdentifiers(
              { facebookUserId: senderId, conversationId },
              country,
            );
            if (updated) {
              countryUpdates++;
              this.logger.log(`🌍 Country updated → ${updated.customerName}: ${country}`);
            }
          }
          continue;
        }

        // Phone found — use best country: this message → pre-scan → Unknown
        const country      = parsed.country ?? allCountries[0] ?? 'Unknown';
        const customerName = await getCustomerName(msg.from?.name);

        const lead = this.leadsService.createLead({
          customerName,
          phone:           parsed.phone,
          country,
          facebookUserId:  senderId,
          conversationId,
          messageSnippet:  parsed.messageSnippet ?? text.substring(0, 200),
          capturedAt,                   // ← Facebook message timestamp
        });

        if (lead) {
          newLeads++;
          this.totalProcessed++;
          this.logger.log(`✅ Lead saved: ${customerName} | ${parsed.phone} | ${country} @ ${capturedAt.toISOString()}`);

          // Attach any additional countries found in other messages
          for (const c of allCountries) {
            if (c !== country) {
              this.leadsService.updateCountryByIdentifiers(
                { facebookUserId: senderId, conversationId }, c,
              );
            }
          }
        }

        // Trim processedMessageIds to avoid unbounded growth
        if (this.processedMessageIds.size > 10000) {
          Array.from(this.processedMessageIds).slice(0, 5000)
            .forEach((id) => this.processedMessageIds.delete(id));
        }
      } catch (err: any) {
        this.logger.error(`Error on msg ${msg.id}: ${err.message}`);
      }
    }

    return { newLeads, countryUpdates };
  }

  async testPollingConnection() {
    const token      = this.config.get('META_PAGE_ACCESS_TOKEN');
    const pageId     = this.config.get('META_PAGE_ID');
    const windowHours = parseInt(this.config.get('POLL_WINDOW_HOURS') ?? '') || DEFAULT_WINDOW_HOURS;

    const result: any = { timestamp: new Date().toISOString(), pageId, windowHours, errors: [] };

    try {
      const { data } = await axios.get(`https://graph.facebook.com/v19.0/${pageId}`, {
        params: { fields: 'name', access_token: token },
      });
      result.pageName = data.name;
    } catch (err: any) { result.errors.push(err.message); return result; }

    try {
      const since = new Date();
      since.setHours(since.getHours() - windowHours);
      const ids = await this.fetchAllConversationIds(token, pageId, since);
      result.conversationsInWindow = ids.length;

      if (ids.length > 0) {
        const arrays = await Promise.all(
          ids.map((id) => this.fetchMessagesInConversation(token, pageId, id, since)),
        );
        result.totalMessages = arrays.flat().length;
        result.perConversation = ids.map((id, i) => ({
          id,
          messages: arrays[i].length,
          countries: arrays[i]
            .map((m) => this.leadsService.extractCountryOnly(m.message ?? ''))
            .filter(Boolean),
        }));
      }
    } catch (err: any) { result.errors.push(err.message); }

    return result;
  }

  getProcessedCount() { return this.totalProcessed; }

  getStatus() {
    return {
      isRunning:        this.isRunning,
      lastPollTime:     this.lastPollTime,
      consecutiveErrors: this.consecutiveErrors,
      totalProcessed:   this.totalProcessed,
      windowHours:      parseInt(this.config.get('POLL_WINDOW_HOURS') ?? '') || DEFAULT_WINDOW_HOURS,
    };
  }
}
