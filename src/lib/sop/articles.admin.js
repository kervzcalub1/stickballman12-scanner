// Administration: accounts, app-wide settings, and the superadmin's extra reach.
const ADMIN = ['admin', 'superadmin'];

export const ADMIN_ARTICLES = [
  {
    id: 'admin-check-access',
    title: 'Approve accounts and manage roles',
    area: 'admin',
    roles: ADMIN,
    summary: 'Nobody gets in until you let them. Check Access is where accounts are approved, re-roled, reset and removed.',
    when: 'Somebody signed up, changed job, forgot their password, or left.',
    diagram: 'role-map',
    shot: 'access',
    steps: [
      { do: 'Home → Administration → Check Access.' },
      { do: 'Pending accounts sit at the top. Check who it actually is before approving anything.' },
      { do: 'Approve with the right role — Warehouse or PH Team for staff, Supplier for an external partner.' },
      { do: 'Change an existing account\'s role from the role dropdown.' },
      { do: 'For a forgotten password, tap "Reset password". A temporary password is generated and shown to you once — copy it and pass it on securely.' },
      { do: 'Reject or delete accounts that should not exist.' },
    ],
    rules: [
      'A "reset requested" badge means the person used "Forgot password?" themselves. It does not reset anything — you still have to issue the temporary password.',
      'The temporary password is shown exactly once and only its hash is stored. If it is lost, issue another.',
      'Someone signing in with a temporary password is forced to set their own before they can use the app at all.',
      'The built-in admin and superadmin accounts have no database row, so they cannot be reset here. Their passwords live in the deployment environment.',
      'Sessions are stateless and last about 8 hours. Deleting an account or changing its role takes effect at their next sign-in, not instantly.',
    ],
    related: ['password-reset', 'roles-map', 'supplier-signup', 'admin-settings'],
    keywords: ['approve', 'pending', 'reject', 'delete', 'role', 'temp password', 'reset', 'accounts', 'users'],
  },
  {
    id: 'admin-settings',
    title: 'Set the price margin',
    area: 'admin',
    roles: ADMIN,
    summary: 'One number drives every Final price in the app. Changing it re-prices unlisted stock immediately.',
    when: 'The business changes its markup.',
    steps: [
      { do: 'Home → Administration → Settings.' },
      { do: 'Set the price margin percentage (0–200).' },
      { do: 'Save. The screen reports how many pairs were re-priced.' },
    ],
    rules: [
      'Every "GI + N%" label in the app reads from this setting — there is no hard-coded markup to chase.',
      'On save, unlisted stock is re-priced to GI × the new margin. "Unlisted" means off Intelligent Inventory AND off every store.',
      'Manual price overrides are preserved. Only prices that were still the old automatic calculation get moved.',
      'Already-listed stock keeps its price until PH re-prices it — a live listing is not disturbed by a settings change.',
      'In-store, sold and shipped pairs are excluded.',
    ],
    related: ['ph-refresh-prices', 'ph-new-inventory'],
    keywords: ['margin', 'markup', 'percent', 'final price', 'reprice', 'settings', 'app settings'],
  },
  {
    id: 'superadmin-ph',
    title: 'Superadmin: work in the PH workspace',
    area: 'admin',
    roles: ['superadmin'],
    summary: 'The superadmin account has everything an admin has, plus the PH team\'s pages — and can edit them, not just read.',
    when: 'Covering for PH, or checking their work first-hand.',
    diagram: 'role-map',
    steps: [
      { do: 'Home → PH Team → PH Team Workspace.' },
      { do: 'You are now in the PH home, with New Inventory, Rescale Stock, Price Inquiry, image tools and the purchase-order pages.' },
      { do: 'Tap Home in the top bar to come back out to the admin home.' },
    ],
    rules: [
      'Unlike a plain admin, superadmin can edit the PH grid and refresh prices.',
      'Superadmin is not a role stored against an account — it is the built-in environment account, and it never appears in the Check Access role picker.',
    ],
    related: ['admin-check-access', 'ph-new-inventory', 'roles-map'],
    keywords: ['superadmin', 'workspace', 'toggle', 'ph mode', 'env account', 'edit'],
  },
];
