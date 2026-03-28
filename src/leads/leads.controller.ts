import { Controller, Get, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { LeadsService } from './leads.service';

@Controller('leads')
export class LeadsController {
  constructor(private readonly leadsService: LeadsService) {}

  @Get('stats')
  getStats() {
    return this.leadsService.getStats();
  }

  // GET /leads?country=مصر&search=ahmed&timeFilter=day
  // GET /leads?dateFrom=2026-03-01T00:00&dateTo=2026-03-28T18:00
  @Get()
  findAll(@Query() q: any) {
    return this.leadsService.findAll({
      country:    q.country,
      search:     q.search,
      timeFilter: q.timeFilter,
      dateFrom:   q.dateFrom,
      dateTo:     q.dateTo,
      page:       q.page  ? parseInt(q.page)  : 1,
      limit:      q.limit ? parseInt(q.limit) : 50,
    });
  }

  // GET /leads/export — respects all filters
  @Get('export')
  async exportCsv(
    @Query('country')    country:    string,
    @Query('timeFilter') timeFilter: 'hour' | 'day' | 'month',
    @Query('dateFrom')   dateFrom:   string,
    @Query('dateTo')     dateTo:     string,
    @Res() res: Response,
  ) {
    const data = this.leadsService.findAllForExport({ country, timeFilter, dateFrom, dateTo });

    const header = 'Name,Phone,Country,Countries History,Captured (FB message time)\n';
    const rows = data
      .map(
        (l) =>
          `"${l.customerName}","${l.phone}","${l.country}","${(l.countriesHistory ?? []).join(' | ')}","${new Date(l.capturedAt).toLocaleString()}"`,
      )
      .join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=leads-${Date.now()}.csv`);
    res.send('\uFEFF' + header + rows); // BOM for Excel Arabic support
  }
}
