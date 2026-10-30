import type { Permission, Role } from '@stellar/shared';

/**
 * Least privilege: front-desk staff can distribute links and read reviews
 * (which contain no contact details) but only see masked complaint contacts.
 */
const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  staff: ['reviews:read', 'complaints:read', 'links:read', 'links:write'],
  manager: [
    'reviews:read',
    'complaints:read',
    'complaints:read_pii',
    'complaints:update',
    'notifications:retry',
    'links:read',
    'links:write',
  ],
  admin: [
    'reviews:read',
    'complaints:read',
    'complaints:read_pii',
    'complaints:update',
    'notifications:retry',
    'links:read',
    'links:write',
    'users:manage',
  ],
};

export function permissionsFor(role: Role): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
