const cron = require('node-cron');
const reportService = require('./reportService');
const { Report } = require('../models');
const { Op } = require('sequelize');
const dayjs = require('dayjs');

function init() {
    console.log('[CRON] Initializing Report Scheduler & Order Sync...');

    // Run every day at 00:01 (one minute past midnight)
    cron.schedule('1 0 * * *', async () => {
        await processScheduledReports();
    });

    // Also run every hour to catch any missed or recently added schedules
    cron.schedule('0 * * * *', async () => {
        console.log('[CRON] Checking for scheduled reports...');
        await processScheduledReports();
    });

    // Run order synchronization every 15 minutes
    cron.schedule('*/15 * * * *', async () => {
        console.log('[CRON] Starting background orders synchronization for integrations...');
        await runAllIntegrationsSync();
    });
}

async function processScheduledReports() {
    try {
        // Check if table exists (to avoid crash on very first run if sync is slow)
        try {
            if (typeof Report.count === 'function') {
                await Report.count();
            } else {
                return;
            }
        } catch (e) {
            console.log('[CRON] Reports table not ready yet, skipping...');
            return;
        }

        const activeReports = await Report.findAll({
            where: {
                schedule: { [Op.ne]: 'ONCE' },
                status: 'COMPLETED'
            }
        });

        for (const report of activeReports) {
            const lastRun = dayjs(report.lastRunAt);
            const now = dayjs();
            let shouldRun = false;

            if (report.schedule === 'DAILY') {
                if (now.diff(lastRun, 'day') >= 1) shouldRun = true;
            } else if (report.schedule === 'WEEKLY') {
                if (now.diff(lastRun, 'week') >= 1) shouldRun = true;
            } else if (report.schedule === 'MONTHLY') {
                if (now.diff(lastRun, 'month') >= 1) shouldRun = true;
            }

            if (shouldRun) {
                console.log(`[CRON] Generating scheduled report: ${report.reportName} (${report.schedule})`);

                // Use a system user or super_admin context for creation
                const systemUser = {
                    id: 0,
                    role: 'super_admin',
                    companyId: report.companyId
                };

                try {
                    await reportService.create({
                        reportType: report.reportType,
                        reportName: `${report.reportName} (${now.format('YYYY-MM-DD')})`,
                        format: report.format,
                        schedule: 'ONCE', // The generated instance is ONCE, the original persists
                        companyId: report.companyId,
                        startDate: report.startDate, // Optional: adjust based on schedule?
                        endDate: report.endDate
                    }, systemUser);

                    // Update the original report template's lastRunAt
                    await report.update({ lastRunAt: new Date() });
                    console.log(`[CRON] Successfully generated: ${report.reportName}`);
                } catch (err) {
                    console.error(`[CRON] Failed to generate report ${report.id}:`, err.message);
                }
            }
        }
    } catch (err) {
        console.error('[CRON] Error processing scheduled reports:', err);
    }
}

async function runAllIntegrationsSync() {
    try {
        const { Company, IntegrationConfig } = require('../models');
        const shopifyService = require('./shopifyService');
        const amazonSpapiService = require('./amazonSpapiService');
        const ebayService = require('./ebayService');

        const companies = await Company.findAll({ attributes: ['id'] });
        for (const company of companies) {
            const companyId = company.id;
            
            // Check Shopify FFD
            try {
                const config = await IntegrationConfig.findOne({ where: { companyId, platform: 'SHOPIFY_FFD', status: 'ACTIVE' } });
                const hasEnv = !!(process.env.SHOPIFY_FFD_DOMAIN && process.env.SHOPIFY_FFD_ACCESS_TOKEN);
                if (config || hasEnv) {
                    await shopifyService.syncOrders(companyId, false);
                }
            } catch (err) {
                console.error(`[CRON] Shopify Retail sync failed for company ${companyId}:`, err.message);
            }

            // Check Shopify Wholesale
            try {
                const config = await IntegrationConfig.findOne({ where: { companyId, platform: 'SHOPIFY_WHOLESALE', status: 'ACTIVE' } });
                const hasEnv = !!(process.env.SHOPIFY_WHOLESALE_DOMAIN && process.env.SHOPIFY_WHOLESALE_ACCESS_TOKEN);
                if (config || hasEnv) {
                    await shopifyService.syncOrders(companyId, true);
                }
            } catch (err) {
                console.error(`[CRON] Shopify Wholesale sync failed for company ${companyId}:`, err.message);
            }

            // Check Amazon
            try {
                const config = await IntegrationConfig.findOne({ where: { companyId, platform: 'AMAZON', status: 'ACTIVE' } });
                const hasEnv = !!(process.env.AMAZON_CLIENT_ID && process.env.AMAZON_CLIENT_SECRET && process.env.AMAZON_REFRESH_TOKEN);
                if (config || hasEnv) {
                    await amazonSpapiService.syncOrders(companyId);
                }
            } catch (err) {
                console.error(`[CRON] Amazon sync failed for company ${companyId}:`, err.message);
            }

            // Check eBay
            try {
                const config = await IntegrationConfig.findOne({ where: { companyId, platform: 'EBAY', status: 'ACTIVE' } });
                const isSandbox = (process.env.EBAY_ENV || 'PRODUCTION') === 'SANDBOX';
                const hasEnv = !!(
                    (isSandbox ? process.env.EBAY_SANDBOX_REFRESH_TOKEN : process.env.EBAY_PROD_REFRESH_TOKEN) &&
                    (isSandbox ? process.env.EBAY_SANDBOX_APP_ID : process.env.EBAY_PROD_APP_ID)
                );
                if (config || hasEnv) {
                    await ebayService.syncOrders(companyId);
                }
            } catch (err) {
                console.error(`[CRON] eBay sync failed for company ${companyId}:`, err.message);
            }
        }
    } catch (err) {
        console.error('[CRON] Error in runAllIntegrationsSync:', err);
    }
}

module.exports = { init };
