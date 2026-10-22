import { PUBLIC } from '../../middleware/authorize.js';
import { defineRoutes } from '../../routes/define-routes.js';
import { sendCreated, sendOk } from '../../utils/response.js';
import { ValidationError, zodIssuesToDetails } from '../../utils/errors.js';
import { SETTINGS_SCHEMAS } from './settings.js';
import { registerOrganizationBody, settingsSectionParams, updateOrganizationBody } from './organizations.schema.js';

export function organizationRoutes({ organizationService }) {
  const tags = ['Organizations'];
  return defineRoutes('/organizations', (r) => {
    r.post('/', { permission: PUBLIC, body: registerOrganizationBody, rateLimit: 'auth-strict', tags, summary: 'Register a new organization and its owner account' }, async (req, res) => {
      sendCreated(res, await organizationService.register(req.ctx, req.valid.body));
    });

    r.get('/current', { permission: 'org.settings.read', tags, summary: 'Current organization profile' }, async (req, res) => {
      sendOk(res, await organizationService.getCurrent(req.ctx));
    });

    r.patch('/current', { permission: 'org.settings.manage', body: updateOrganizationBody, tags, summary: 'Update the organization profile' }, async (req, res) => {
      sendOk(res, await organizationService.updateCurrent(req.ctx, req.valid.body));
    });

    r.get('/current/settings', { permission: 'org.settings.read', tags, summary: 'All settings sections (defaults merged)' }, async (req, res) => {
      const { settings, version } = await organizationService.getSettings(req.ctx);
      sendOk(res, settings, { meta: { version } });
    });

    r.put(
      '/current/settings/:section',
      { permission: 'org.settings.manage', params: settingsSectionParams, tags, summary: 'Replace one settings section' },
      async (req, res) => {
        const { section } = req.valid.params;
        const parsed = SETTINGS_SCHEMAS[section].safeParse(req.body);
        if (!parsed.success) throw new ValidationError(zodIssuesToDetails(parsed.error.issues, 'body'));
        sendOk(res, await organizationService.updateSettingsSection(req.ctx, section, parsed.data));
      },
    );
  });
}
