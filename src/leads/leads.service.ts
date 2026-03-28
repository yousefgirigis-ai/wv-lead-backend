import { Injectable, Logger } from '@nestjs/common';

// ── Arabic-Indic → Western digits ────────────────────────────────
export function toWesternDigits(text: string): string {
  return text
    .replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (c) => String(c.charCodeAt(0) - 0x06F0));
}

// ── Phone regex ───────────────────────────────────────────────────
const PHONE_REGEX =
  /(\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,6}/;

// ── Strip Arabic diacritics + normalise ──────────────────────────
function normaliseArabic(text: string): string {
  return text
    .replace(/[\u064B-\u0652\u0670\u0671]/g, '') // tashkeel + superscript alef + alef wasla
    .replace(/[أإآا]/g, 'ا')                      // unify alef variants → bare alef
    .replace(/[ىي]/g, 'ي')                        // unify ya variants
    .replace(/ة/g, 'ه')                           // ta marbuta → ha (common typo swap)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// ── Levenshtein distance (character-level) ───────────────────────
// Used for fuzzy matching misspelled country names.
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// ── Fuzzy threshold: allow 1 edit per 5 chars, min 1, max 3 ──────
function fuzzyThreshold(keyword: string): number {
  return Math.min(3, Math.max(1, Math.floor(keyword.length / 5)));
}

// ── Country hints: English + Arabic (including common misspellings)
export const COUNTRY_HINTS: Record<string, string[]> = {
  // ── Arab world ──────────────────────────────────────────────────
  Egypt: [
    'egypt', 'cairo', 'alexandria', 'giza', 'luxor', 'aswan', 'hurghada',
    'مصر', 'القاهره', 'القاهرة', 'الاسكندريه', 'الاسكندرية', 'الجيزه', 'الجيزة',
    'الاقصر', 'الأقصر', 'اسوان', 'أسوان', 'الغردقه', 'الغردقة',
  ],
  'Saudi Arabia': [
    'saudi', 'ksa', 'riyadh', 'jeddah', 'mecca', 'medina', 'dammam', 'tabuk',
    'السعوديه', 'السعودية', 'المملكه', 'المملكة', 'الرياض', 'جده', 'جدة',
    'مكه', 'مكة', 'المدينه', 'المدينة', 'الدمام', 'المملكه العربيه السعوديه',
  ],
  UAE: [
    'uae', 'dubai', 'abu dhabi', 'sharjah', 'ajman', 'fujairah', 'emirates',
    'الامارات', 'الإمارات', 'دبي', 'ابوظبي', 'أبوظبي', 'الشارقه', 'الشارقة', 'عجمان',
  ],
  Kuwait: ['kuwait', 'kuweit', 'الكويت', 'الكويت'],
  Qatar: ['qatar', 'doha', 'قطر', 'الدوحه', 'الدوحة'],
  Jordan: ['jordan', 'amman', 'irbid', 'الاردن', 'الأردن', 'عمان', 'اربد'],
  Bahrain: ['bahrain', 'manama', 'البحرين', 'المنامه', 'المنامة'],
  Oman: ['oman', 'muscat', 'عمان', 'مسقط', 'سلطنه عمان', 'سلطنة عمان'],
  Yemen: ['yemen', 'sanaa', 'اليمن', 'صنعاء', 'صنعا'],
  Libya: ['libya', 'tripoli', 'benghazi', 'ليبيا', 'طرابلس', 'بنغازي'],
  Morocco: ['morocco', 'casablanca', 'rabat', 'marrakech', 'fez',
    'المغرب', 'الدار البيضاء', 'الرباط', 'مراكش', 'فاس'],
  Tunisia: ['tunisia', 'tunis', 'تونس'],
  Algeria: ['algeria', 'algiers', 'الجزائر', 'وهران', 'الجزاير'],
  Iraq: ['iraq', 'baghdad', 'basra', 'العراق', 'بغداد', 'البصره', 'البصرة'],
  Syria: ['syria', 'damascus', 'aleppo', 'سوريا', 'سوريه', 'دمشق', 'حلب'],
  Lebanon: ['lebanon', 'beirut', 'لبنان', 'بيروت'],
  Palestine: ['palestine', 'gaza', 'westbank', 'west bank', 'فلسطين', 'غزه', 'غزة', 'الضفه'],
  Sudan: ['sudan', 'khartoum', 'السودان', 'الخرطوم'],
  Somalia: ['somalia', 'mogadishu', 'الصومال', 'مقديشو'],
  Mauritania: ['mauritania', 'موريتانيا'],
  Djibouti: ['djibouti', 'جيبوتي'],

  // ── Central Asia (previously missing — root cause of the bug) ───
  Uzbekistan: [
    'uzbekistan', 'tashkent', 'samarkand', 'bukhara',
    'اوزبكستان', 'أوزبكستان', 'اوزباكستان', 'أوزباكستان',
    'اوزبكستن', 'أوزبكستن',                    // ← common misspelling
    'طشقند', 'سمرقند', 'بخارى',
  ],
  Kazakhstan: [
    'kazakhstan', 'astana', 'almaty', 'nur-sultan',
    'كازاخستان', 'كازاخستن', 'قازاخستان', 'قازاقستان',
    'استانا', 'الماتي',
  ],
  Kyrgyzstan: [
    'kyrgyzstan', 'bishkek',
    'قيرغيزستان', 'قيرغيزستن', 'قرغيزستان', 'كيرغيزستان',
    'بيشكيك',
  ],
  Tajikistan: [
    'tajikistan', 'dushanbe',
    'طاجيكستان', 'طاجيكستن', 'تاجيكستان', 'تاجيكستن',
    'دوشنبه',
  ],
  Turkmenistan: [
    'turkmenistan', 'ashgabat',
    'تركمانستان', 'تركمانستن', 'تركمنستان',
    'عشق اباد', 'عشق آباد',
  ],
  Afghanistan: [
    'afghanistan', 'kabul', 'kandahar',
    'افغانستان', 'أفغانستان', 'افغانستن', 'افغانستن',
    'كابل', 'قندهار',
  ],

  // ── Asia ────────────────────────────────────────────────────────
  India: [
    'india', 'delhi', 'mumbai', 'bangalore', 'chennai', 'kolkata', 'hyderabad',
    'الهند', 'هند', 'بومباي', 'دلهي', 'نيودلهي',
  ],
  China: [
    'china', 'beijing', 'shanghai', 'shenzhen', 'guangzhou', 'chengdu',
    'الصين', 'بكين', 'شنغهاي',
  ],
  Pakistan: [
    'pakistan', 'karachi', 'lahore', 'islamabad',
    'باكستان', 'باكستن', 'كراتشي', 'لاهور', 'اسلام اباد', 'إسلام آباد',
  ],
  Turkey: [
    'turkey', 'türkiye', 'istanbul', 'ankara', 'izmir',
    'تركيا', 'تركيه', 'اسطنبول', 'إسطنبول', 'انقره', 'أنقرة',
  ],
  Iran: ['iran', 'tehran', 'إيران', 'ايران', 'طهران'],
  Indonesia: ['indonesia', 'jakarta', 'إندونيسيا', 'اندونيسيا', 'جاكرتا'],
  Malaysia: ['malaysia', 'kuala lumpur', 'ماليزيا', 'كوالالمبور'],
  Bangladesh: ['bangladesh', 'dhaka', 'بنغلاديش', 'بنجلاديش', 'داكا'],
  Philippines: ['philippines', 'manila', 'الفلبين', 'مانيلا'],
  Thailand: ['thailand', 'bangkok', 'تايلاند', 'تايلنده', 'بانكوك'],
  Vietnam: ['vietnam', 'hanoi', 'فيتنام', 'هانوي'],
  Japan: ['japan', 'tokyo', 'osaka', 'اليابان', 'طوكيو'],
  'South Korea': ['korea', 'seoul', 'كوريا', 'سيول'],
  Singapore: ['singapore', 'سنغافوره', 'سنغافورة'],
  'Sri Lanka': ['sri lanka', 'colombo', 'سريلانكا'],
  Nepal: ['nepal', 'kathmandu', 'نيبال'],

  // ── Africa ──────────────────────────────────────────────────────
  Nigeria: ['nigeria', 'lagos', 'abuja', 'نيجيريا', 'لاغوس'],
  Ethiopia: ['ethiopia', 'addis ababa', 'إثيوبيا', 'اثيوبيا'],
  Kenya: ['kenya', 'nairobi', 'كينيا', 'نيروبي'],
  Ghana: ['ghana', 'accra', 'غانا'],
  Tanzania: ['tanzania', 'dar es salaam', 'تنزانيا'],
  'South Africa': ['south africa', 'johannesburg', 'cape town', 'جنوب افريقيا', 'جنوب أفريقيا'],
  Senegal: ['senegal', 'dakar', 'السنغال'],

  // ── Europe ──────────────────────────────────────────────────────
  'United Kingdom': [
    'uk', 'britain', 'england', 'london', 'manchester', 'birmingham', 'scotland', 'wales',
    'بريطانيا', 'انجلترا', 'إنجلترا', 'لندن', 'المملكه المتحده', 'المملكة المتحدة',
  ],
  Germany: ['germany', 'berlin', 'munich', 'frankfurt', 'المانيا', 'ألمانيا', 'برلين'],
  France: ['france', 'paris', 'lyon', 'marseille', 'فرنسا', 'باريس'],
  Italy: ['italy', 'rome', 'milan', 'ايطاليا', 'إيطاليا', 'روما', 'ميلان'],
  Spain: ['spain', 'madrid', 'barcelona', 'اسبانيا', 'إسبانيا', 'مدريد'],
  Netherlands: ['netherlands', 'holland', 'amsterdam', 'هولندا', 'امستردام', 'أمستردام'],
  Belgium: ['belgium', 'brussels', 'بلجيكا', 'بروكسل'],
  Sweden: ['sweden', 'stockholm', 'السويد', 'ستوكهولم'],
  Norway: ['norway', 'oslo', 'النرويج', 'اوسلو', 'أوسلو'],
  Denmark: ['denmark', 'copenhagen', 'الدنمارك'],
  Switzerland: ['switzerland', 'zurich', 'geneva', 'سويسرا', 'زيورخ'],
  Austria: ['austria', 'vienna', 'النمسا', 'فيينا'],
  Poland: ['poland', 'warsaw', 'بولندا', 'وارسو'],
  Greece: ['greece', 'athens', 'اليونان', 'اثينا', 'أثينا'],
  Portugal: ['portugal', 'lisbon', 'البرتغال', 'لشبونه', 'لشبونة'],
  Russia: ['russia', 'moscow', 'روسيا', 'موسكو'],

  // ── Americas ────────────────────────────────────────────────────
  'United States': [
    'usa', 'united states', 'america', 'new york', 'california', 'texas', 'florida', 'chicago',
    'امريكا', 'أمريكا', 'الولايات المتحده', 'الولايات المتحدة', 'نيويورك',
  ],
  Canada: ['canada', 'toronto', 'vancouver', 'montreal', 'calgary', 'كندا', 'تورنتو', 'فانكوفر'],
  Brazil: ['brazil', 'sao paulo', 'rio', 'البرازيل', 'ساو باولو'],
  Mexico: ['mexico', 'ciudad de mexico', 'المكسيك', 'مكسيكو'],
  Argentina: ['argentina', 'buenos aires', 'الارجنتين', 'الأرجنتين', 'بيونس ايرس'],
  Colombia: ['colombia', 'bogota', 'كولومبيا', 'بوغوتا'],
  Chile: ['chile', 'santiago', 'شيلي', 'سانتياغو'],

  // ── Oceania ─────────────────────────────────────────────────────
  Australia: ['australia', 'sydney', 'melbourne', 'brisbane', 'perth', 'استراليا', 'أستراليا', 'سيدني', 'ملبورن'],
  'New Zealand': ['new zealand', 'auckland', 'نيوزيلندا', 'نيوزيلنده', 'اوكلاند', 'أوكلاند'],
};

// ── Build a flat list of (keyword, canonical) pairs once at startup
// used by fuzzy matching — only for Arabic keywords (≥4 chars)
const FUZZY_ARABIC_KEYWORDS: Array<{ kw: string; canonical: string }> = [];
for (const [canonical, keywords] of Object.entries(COUNTRY_HINTS)) {
  for (const kw of keywords) {
    // Only fuzzy-match Arabic keywords that are long enough to be meaningful
    if (/[\u0600-\u06FF]/.test(kw) && kw.length >= 4) {
      FUZZY_ARABIC_KEYWORDS.push({ kw: normaliseArabic(kw), canonical });
    }
  }
}

const ALIASES: Record<string, string> = {
  usa: 'United States', america: 'United States',
  أمريكا: 'United States', امريكا: 'United States',
  uk: 'United Kingdom', britain: 'United Kingdom',
  بريطانيا: 'United Kingdom', انجلترا: 'United Kingdom',
  ksa: 'Saudi Arabia', saudi: 'Saudi Arabia',
  السعودية: 'Saudi Arabia', المملكة: 'Saudi Arabia',
  uae: 'UAE', emirates: 'UAE',
  الإمارات: 'UAE', الامارات: 'UAE',
  الهند: 'India', هند: 'India',
  الصين: 'China', تركيا: 'Turkey',
  // Central Asia shortcuts
  اوزبكستان: 'Uzbekistan', أوزبكستان: 'Uzbekistan',
  كازاخستان: 'Kazakhstan', قازاقستان: 'Kazakhstan',
  طاجيكستان: 'Tajikistan', تاجيكستان: 'Tajikistan',
  تركمانستان: 'Turkmenistan',
  قيرغيزستان: 'Kyrgyzstan', كيرغيزستان: 'Kyrgyzstan',
  افغانستان: 'Afghanistan', أفغانستان: 'Afghanistan',
};

export interface ParsedLead {
  phone: string;
  country?: string;
  messageSnippet?: string;
}

export interface LeadRecord {
  id: string;
  customerName: string;
  phone: string;
  country: string;
  countriesHistory: string[];
  facebookUserId?: string;
  conversationId?: string;
  messageSnippet?: string;
  capturedAt: Date;
}

@Injectable()
export class LeadsService {
  private readonly logger = new Logger(LeadsService.name);
  private readonly store = new Map<string, LeadRecord>();
  private nextId = 1;

  // ── Step 1: Exact keyword scan (fast path) ────────────────────
  // Tries to match any COUNTRY_HINTS keyword as a substring.
  // Uses normaliseArabic() so alef variants, ta marbuta, etc. match.
  private exactCountryScan(normalisedMessage: string): string | undefined {
    for (const [canonical, keywords] of Object.entries(COUNTRY_HINTS)) {
      for (const kw of keywords) {
        const normKw = normaliseArabic(kw);
        if (normalisedMessage.includes(normKw)) return canonical;
      }
    }
    return undefined;
  }

  // ── Step 2: Fuzzy scan (slow path, Arabic only) ───────────────
  // Splits the message into word-level tokens and checks Levenshtein
  // distance against every Arabic keyword. Returns the closest match
  // whose edit distance is within the adaptive threshold.
  //
  // WHY THIS FIXES THE BUG:
  // "اوزبكستن" doesn't match any exact keyword, so the old code fell
  // through and grabbed the last successfully matched country from a
  // previous message.  With fuzzy matching we measure how close
  // "اوزبكستن" is to "اوزبكستان" (distance=2) vs any other keyword,
  // and return "Uzbekistan" instead of a wrong country.
  private fuzzyCountryScan(normalisedMessage: string): string | undefined {
    // Only meaningful for Arabic text
    if (!/[\u0600-\u06FF]/.test(normalisedMessage)) return undefined;

    // Tokenise: split on whitespace and punctuation
    const tokens = normalisedMessage.split(/[\s،,،.؟?!،\-]+/).filter((t) => t.length >= 4);

    let bestCanonical: string | undefined;
    let bestDist = Infinity;

    for (const token of tokens) {
      for (const { kw, canonical } of FUZZY_ARABIC_KEYWORDS) {
        const threshold = fuzzyThreshold(kw);
        // Skip if lengths differ too much (quick pre-filter)
        if (Math.abs(token.length - kw.length) > threshold) continue;
        const dist = levenshtein(token, kw);
        if (dist <= threshold && dist < bestDist) {
          bestDist = dist;
          bestCanonical = canonical;
          if (dist === 0) break; // exact match can't be beaten
        }
      }
      if (bestDist === 0) break;
    }

    return bestCanonical;
  }

  // ── normalizeCountry ─────────────────────────────────────────
  normalizeCountry(raw: string): string {
    if (!raw) return 'Unknown';
    const stripped = raw.replace(/[\u064B-\u0652]/g, '').replace(/[.\-_]/g, ' ').replace(/\s+/g, ' ').trim();
    const lower = stripped.toLowerCase();
    if (ALIASES[lower]) return ALIASES[lower];
    if (ALIASES[stripped]) return ALIASES[stripped];

    // Exact scan
    const exact = this.exactCountryScan(normaliseArabic(stripped));
    if (exact) return exact;

    // Fuzzy scan
    const fuzzy = this.fuzzyCountryScan(normaliseArabic(stripped));
    if (fuzzy) return fuzzy;

    return stripped.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  }

  // ── extractCountryOnly ────────────────────────────────────────
  // FLOW:
  //  1. Alias exact match (fastest — single lookup)
  //  2. Exact keyword scan (substring match after normalisation)
  //  3. English phrase patterns ("from X", "living in X", …)
  //  4. Arabic phrase patterns ("انا من X", "بلدي X", …)
  //  5. Fuzzy scan (only if all above failed — catches misspellings)
  extractCountryOnly(message: string): string | undefined {
    if (!message) return undefined;

    const norm = normaliseArabic(toWesternDigits(message));

    // ── 1. Alias exact match ──
    const trimmed = message.replace(/[\u064B-\u0652]/g, '').trim();
    if (ALIASES[trimmed.toLowerCase()]) return ALIASES[trimmed.toLowerCase()];
    if (ALIASES[trimmed]) return ALIASES[trimmed];

    // ── 2. Exact keyword scan ──
    const exact = this.exactCountryScan(norm);
    if (exact) return exact;

    // ── 3. English phrase patterns ──
    const enMatch = norm.match(
      /(?:my country is|country[:\s]+|i(?:'m| am) from|from|based in|living in|interested in)\s+([a-z][a-z\s.'-]{1,35})/,
    );
    if (enMatch?.[1]) {
      const c = enMatch[1].replace(/[.,;!?]+$/, '').trim();
      if (c.split(/\s+/).length <= 4 && !/\d/.test(c)) {
        const n = this.normalizeCountry(c);
        if (n !== 'Unknown') return n;
      }
    }

    // ── 4. Arabic phrase patterns ──
    const arMatch = message.match(
      /(?:الدوله|الدولة|البلد|بلدي|أنا من|انا من|من دوله|من دولة|مهتم في|مهتم بـ)[:\s]*([ء-ي][ء-ي\s.'-]{1,35})/,
    );
    if (arMatch?.[1]) {
      const c = arMatch[1].replace(/[.,;!?،]+$/, '').trim();
      if (c.split(/\s+/).length <= 4) {
        // Try exact first, then fuzzy on the extracted fragment
        const n = this.normalizeCountry(c);
        if (n !== 'Unknown') return n;
      }
    }

    // ── 5. Fuzzy scan — LAST RESORT for misspelled country names ──
    // This is the fix: instead of returning undefined (and the caller
    // then using the PREVIOUS message's country), we try to find the
    // closest Arabic country name via edit distance.
    const fuzzy = this.fuzzyCountryScan(norm);
    if (fuzzy) {
      this.logger.debug(`Fuzzy matched "${message.trim()}" → ${fuzzy}`);
      return fuzzy;
    }

    return undefined;
  }

  private countryFromPhone(phone: string): string | undefined {
    const d = toWesternDigits(phone).replace(/\D/g, '');
    if (/^(01[0-9]{9}|20[0-9]{10}|0020[0-9]{10})$/.test(d)) return 'Egypt';
    if (/^966[0-9]{8,9}$/.test(d)) return 'Saudi Arabia';
    if (/^971[0-9]{8,9}$/.test(d)) return 'UAE';
    if (/^965[0-9]{7,8}$/.test(d)) return 'Kuwait';
    if (/^974[0-9]{7,8}$/.test(d)) return 'Qatar';
    if (/^973[0-9]{7,8}$/.test(d)) return 'Bahrain';
    if (/^968[0-9]{7,8}$/.test(d)) return 'Oman';
    if (/^962[0-9]{8,9}$/.test(d)) return 'Jordan';
    if (/^961[0-9]{7,8}$/.test(d)) return 'Lebanon';
    if (/^964[0-9]{9,10}$/.test(d)) return 'Iraq';
    if (/^92[0-9]{10}$/.test(d)) return 'Pakistan';
    if (/^91[0-9]{10}$/.test(d)) return 'India';
    if (/^86[0-9]{10,11}$/.test(d)) return 'China';
    if (/^90[0-9]{10}$/.test(d)) return 'Turkey';
    if (/^44[0-9]{10}$/.test(d)) return 'United Kingdom';
    if (/^61[0-9]{9}$/.test(d)) return 'Australia';
    if (/^49[0-9]{10,11}$/.test(d)) return 'Germany';
    if (/^33[0-9]{9}$/.test(d)) return 'France';
    if (/^39[0-9]{9,10}$/.test(d)) return 'Italy';
    if (/^34[0-9]{9}$/.test(d)) return 'Spain';
    if (/^7[0-9]{10}$/.test(d)) return 'Russia';
    if (/^1[0-9]{10}$/.test(d)) return 'United States';
    return undefined;
  }

  parseMessage(rawMessage: string): ParsedLead | null {
    if (!rawMessage) return null;
    const message = toWesternDigits(rawMessage);
    const match = message.match(PHONE_REGEX);
    if (!match) return null;
    const phone = match[0];
    const country = this.extractCountryOnly(rawMessage) ?? this.countryFromPhone(phone);
    return { phone, country, messageSnippet: rawMessage.substring(0, 200) };
  }

  private normalisePhone(phone: string): string {
    return toWesternDigits(phone).replace(/[\s\-().]/g, '');
  }

  createLead(data: {
    customerName: string;
    phone: string;
    country?: string;
    facebookUserId?: string;
    conversationId?: string;
    messageSnippet?: string;
    capturedAt: Date;
  }): LeadRecord | null {
    const phone = this.normalisePhone(data.phone);
    if (this.store.has(phone)) {
      this.logger.log(`Duplicate phone ${phone} — skipped`);
      return null;
    }
    const country = data.country ? this.normalizeCountry(data.country) : 'Unknown';
    const lead: LeadRecord = {
      id: String(this.nextId++).padStart(3, '0'),
      customerName: data.customerName,
      phone,
      country,
      countriesHistory: country !== 'Unknown' ? [country] : [],
      facebookUserId: data.facebookUserId,
      conversationId: data.conversationId,
      messageSnippet: data.messageSnippet,
      capturedAt: data.capturedAt,
    };
    this.store.set(phone, lead);
    this.logger.log(`✅ New lead: ${data.customerName} | ${phone} | ${country} @ ${data.capturedAt.toISOString()}`);
    return lead;
  }

  updateCountryByIdentifiers(
    identifiers: { facebookUserId?: string; conversationId?: string },
    rawCountry: string,
  ): LeadRecord | null {
    if (!rawCountry) return null;
    const country = this.normalizeCountry(rawCountry);
    if (country === 'Unknown') return null;

    let best: LeadRecord | null = null;
    for (const lead of this.store.values()) {
      const match =
        (identifiers.conversationId && lead.conversationId === identifiers.conversationId) ||
        (identifiers.facebookUserId && lead.facebookUserId === identifiers.facebookUserId);
      if (match && (!best || lead.capturedAt > best.capturedAt)) best = lead;
    }
    if (!best) return null;
    best.country = country;
    if (!best.countriesHistory.includes(country)) best.countriesHistory.push(country);
    return best;
  }

  findAll(filters: {
    country?: string; search?: string; page?: number; limit?: number;
    timeFilter?: 'hour' | 'day' | 'month'; dateFrom?: string; dateTo?: string;
  }) {
    const { country, search, page = 1, limit = 50, timeFilter, dateFrom, dateTo } = filters;
    let results = Array.from(this.store.values());

    if (dateFrom || dateTo) {
      const from = dateFrom ? new Date(dateFrom) : null;
      const to = dateTo ? new Date(dateTo) : null;
      results = results.filter((l) => {
        if (from && l.capturedAt < from) return false;
        if (to && l.capturedAt > to) return false;
        return true;
      });
    } else if (timeFilter) {
      const now = new Date(), from = new Date(now);
      if (timeFilter === 'hour') from.setHours(now.getHours() - 1);
      else if (timeFilter === 'day') from.setDate(now.getDate() - 1);
      else if (timeFilter === 'month') from.setMonth(now.getMonth() - 1);
      results = results.filter((l) => l.capturedAt >= from);
    }

    if (country) {
      const n = this.normalizeCountry(country).toLowerCase();
      results = results.filter(
        (l) => l.country.toLowerCase().includes(n) ||
          l.countriesHistory.some((c) => c.toLowerCase().includes(n)),
      );
    }

    if (search) {
      const s = search.toLowerCase();
      results = results.filter(
        (l) => l.customerName.toLowerCase().includes(s) || l.phone.includes(s),
      );
    }

    results.sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime());
    const total = results.length;
    const data = results.slice((page - 1) * limit, page * limit);
    return { data, total, page, limit };
  }

  getStats() {
    const all = Array.from(this.store.values());
    const byCountry: Record<string, number> = {};
    for (const l of all) byCountry[l.country] = (byCountry[l.country] ?? 0) + 1;
    return {
      total: all.length,
      byCountry: Object.entries(byCountry)
        .map(([_id, count]) => ({ _id, count }))
        .sort((a, b) => b.count - a.count),
    };
  }

  findAllForExport(filters: {
    country?: string; timeFilter?: 'hour' | 'day' | 'month';
    dateFrom?: string; dateTo?: string;
  }) {
    const { data } = this.findAll({ ...filters, limit: 100000, page: 1 });
    return data;
  }
}
