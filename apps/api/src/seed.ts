import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { DataSource, In } from 'typeorm';
import { dataSourceOptions } from './database/data-source';
import { CryptoService } from './common/crypto/crypto.service';
import { Permission } from './modules/rbac/entities/permission.entity';
import { Role } from './modules/rbac/entities/role.entity';
import { PERMISSIONS, ROLES } from './modules/rbac/permissions.catalogue';
import { User } from './modules/auth/entities/user.entity';
import { SECURITY_SETTINGS_ID, SecuritySettings } from './modules/auth/entities/security-settings.entity';
import { Channel, ChannelKey } from './modules/channel/entities/channel.entity';

loadEnv();

/**
 * Idempotent seed — safe to run on every deploy, not just the first.
 *
 * The rules that make it safe to re-run against a live database:
 *  - Permissions are upserted; a key that disappears from the catalogue is REPORTED, never deleted
 *    (deleting one would silently revoke access from every role holding it).
 *  - A role's default permission set is applied only when the role is first created. A later run
 *    never overwrites an operator's deliberate changes.
 *  - The admin user is created only if no user exists at all. It never resets an existing password —
 *    a seed that quietly restored a known password on every deploy would be a backdoor.
 */
async function seed(): Promise<void> {
  const dataSource = new DataSource(dataSourceOptions);
  await dataSource.initialize();

  try {
    const permissionRepo = dataSource.getRepository(Permission);
    const roleRepo = dataSource.getRepository(Role);
    const userRepo = dataSource.getRepository(User);
    const channelRepo = dataSource.getRepository(Channel);
    const securityRepo = dataSource.getRepository(SecuritySettings);

    // --- Permissions ------------------------------------------------------
    let permissionsAdded = 0;
    for (const definition of PERMISSIONS) {
      const existing = await permissionRepo.findOne({ where: { key: definition.key } });
      if (existing) {
        existing.label = definition.label;
        existing.category = definition.category;
        existing.isDangerous = definition.isDangerous ?? false;
        await permissionRepo.save(existing);
      } else {
        await permissionRepo.save(
          permissionRepo.create({
            key: definition.key,
            label: definition.label,
            category: definition.category,
            isDangerous: definition.isDangerous ?? false,
          }),
        );
        permissionsAdded++;
      }
    }

    const catalogueKeys = new Set(PERMISSIONS.map((p) => p.key));
    const orphaned = (await permissionRepo.find()).filter((p) => !catalogueKeys.has(p.key));
    if (orphaned.length > 0) {
      console.warn(
        `[seed] ${orphaned.length} permission(s) exist in the database but not in the catalogue and were LEFT IN PLACE: ` +
          `${orphaned.map((p) => p.key).join(', ')}. Remove them deliberately if they are obsolete.`,
      );
    }

    console.log(`[seed] permissions: ${PERMISSIONS.length} in catalogue, ${permissionsAdded} newly created`);

    // --- Roles ------------------------------------------------------------
    let rolesCreated = 0;
    for (const definition of ROLES) {
      let role = await roleRepo.findOne({ where: { key: definition.key }, relations: ['permissions'] });
      if (role) continue; // never overwrite an operator's edits

      role = roleRepo.create({
        key: definition.key,
        name: definition.name,
        description: definition.description,
        isSystem: true,
        isSuperAdmin: definition.isSuperAdmin ?? false,
        permissions: await permissionRepo.find({ where: { key: In([...definition.permissions]) } }),
      });
      await roleRepo.save(role);
      rolesCreated++;
    }
    console.log(`[seed] roles: ${ROLES.length} defined, ${rolesCreated} newly created`);

    // --- Security settings singleton --------------------------------------
    if (!(await securityRepo.findOne({ where: { id: SECURITY_SETTINGS_ID } }))) {
      await securityRepo.save(securityRepo.create({ id: SECURITY_SETTINGS_ID }));
      console.log('[seed] security settings singleton created');
    }

    // --- Channel registry -------------------------------------------------
    // Future channels are seeded disabled: they are the registry the UI reads, and shipping them
    // as rows now means adding Messenger later is an adapter plus a flag, not a migration.
    const channels: Array<{ key: ChannelKey; name: string; isEnabled: boolean; adapterKey: string | null }> = [
      { key: ChannelKey.WHATSAPP, name: 'WhatsApp', isEnabled: true, adapterKey: 'gowa' },
      { key: ChannelKey.MESSENGER, name: 'Messenger', isEnabled: false, adapterKey: null },
      { key: ChannelKey.FACEBOOK_PAGE, name: 'Facebook Page', isEnabled: false, adapterKey: null },
      { key: ChannelKey.INSTAGRAM, name: 'Instagram', isEnabled: false, adapterKey: null },
    ];
    for (const channel of channels) {
      if (!(await channelRepo.findOne({ where: { key: channel.key } }))) {
        await channelRepo.save(channelRepo.create(channel));
      }
    }
    console.log(`[seed] channels: ${channels.length} registered`);

    // --- First admin ------------------------------------------------------
    const userCount = await userRepo.count();
    if (userCount === 0) {
      const crypto = new CryptoService({
        getOrThrow: () => process.env.SECRET_ENCRYPTION_KEY,
      } as never);

      const password = process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe!123';

      // A super admin whose password is in the repository is not a credential, it is a published
      // one — and §201 forbids default credentials in production outright. In development the
      // default keeps first-run friction low; in production the seed refuses rather than creating
      // an account anybody who has read this file can sign in with.
      if (password === 'ChangeMe!123' && process.env.NODE_ENV === 'production') {
        throw new Error(
          'Refusing to create the first administrator with the documented default password. ' +
            'Set SEED_ADMIN_PASSWORD to something private and run the seed again.',
        );
      }

      const superAdmin = await roleRepo.findOneOrFail({ where: { key: 'super_admin' } });

      await userRepo.save(
        userRepo.create({
          username: process.env.SEED_ADMIN_USERNAME ?? 'admin',
          email: process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com',
          name: 'Administrator',
          passwordHash: crypto.hashPassword(password),
          isActive: true,
          roles: [superAdmin],
        }),
      );

      console.log(`[seed] created first admin user "${process.env.SEED_ADMIN_USERNAME ?? 'admin'}"`);
      if (password === 'ChangeMe!123') {
        console.warn('[seed] the admin password is the documented default — change it before exposing this instance');
      }
    } else {
      console.log(`[seed] ${userCount} user(s) already exist — admin creation skipped, no password reset`);
    }

    console.log('[seed] done');
  } finally {
    await dataSource.destroy();
  }
}

seed().catch((error) => {
  console.error('[seed] failed', error);
  process.exit(1);
});
