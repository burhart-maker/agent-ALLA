const { CORE_INSTRUCTIONS } = require('./core');

// Registry of known tenants. Add a new tenant by dropping a file in
// ./tenants/<id>.js exporting a single overlay string, then registering it
// here. This mirrors the "tenant = CORE + overlay, assembled at request
// time" model from layer-3-saas-architecture.md — no separate routing
// engine needed.
const TENANT_OVERLAYS = {
  roility: require('./tenants/roility').ROILITY_OVERLAY,
};

/**
 * Build the final system prompt for a given tenant.
 * @param {string} tenantId
 * @returns {string}
 */
function composePrompt(tenantId) {
  const overlay = TENANT_OVERLAYS[tenantId];
  if (!overlay) {
    throw new Error(`Unknown tenant: ${tenantId}`);
  }
  return `${CORE_INSTRUCTIONS}\n\n---\n\n${overlay}`;
}

function listTenants() {
  return Object.keys(TENANT_OVERLAYS);
}

module.exports = { composePrompt, listTenants };
