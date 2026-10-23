import type { ComponentType } from 'react';
import { IconActivity, IconAlertCircle, IconBarChart, IconBookOpen, IconBot, IconGrid, IconLightbulb, IconMessageCircle, IconOctagonAlert, IconSettings, IconShieldAlert, IconSliders, IconSparkles, IconUserCircle, IconUsers, IconZap } from './components/icons';

export interface NavigationItem {
  to: string;
  label: string;
  description: string;
  section: string;
  permission?: string;
  icon: ComponentType<{ size?: number }>;
  end?: boolean;
  keywords?: string;
}
export const NAVIGATION: NavigationItem[] = [
  { to: '/', label: 'Overview', description: 'Your support operation at a glance', section: 'Workspace', icon: IconGrid, end: true },
  { to: '/whatsapp', label: 'WhatsApp', description: 'Chats, devices, QR, status, groups and all WhatsApp features', section: 'Workspace', permission: 'channels.read', icon: IconMessageCircle, keywords: 'inbox chat messages media voice sticker poll contact group qr scan device account channels status scheduled' },
  { to: '/support-queue', label: 'Support queue', description: 'Waiting conversations and personal assignments', section: 'Workspace', permission: 'conversations.read', icon: IconAlertCircle },
  { to: '/customers', label: 'Customers', description: 'Customer directory and Client 360°', section: 'Workspace', permission: 'customers.read', icon: IconUserCircle },
  { to: '/knowledge', label: 'Knowledge base', description: 'Verified sources and support answers', section: 'Intelligence', permission: 'knowledge.read', icon: IconBookOpen },
  { to: '/automation', label: 'Automation rules', description: 'Build, review and test support rules', section: 'Intelligence', permission: 'automation.read', icon: IconZap, end: true },
  { to: '/automation/candidates', label: 'Proposed automation', description: 'Review patterns before activation', section: 'Intelligence', permission: 'automation.read', icon: IconLightbulb },
  { to: '/ai/providers', label: 'AI configuration', description: 'Manage providers, models and support policies', section: 'Intelligence', permission: 'settings.read', icon: IconSparkles },
  { to: '/copilot', label: 'AI copilot', description: 'Explore operations with the admin assistant', section: 'Intelligence', permission: 'automation.simulate', icon: IconBot },
  { to: '/team', label: 'Team & scheduling', description: 'Teams, duty roster and leave requests', section: 'Operations', permission: 'team.manage', icon: IconUsers },
  { to: '/support-members', label: 'Support members', description: 'Staff channel identities and activity', section: 'Operations', permission: 'team.manage', icon: IconUsers },
  { to: '/support-activity', label: 'Support activity', description: 'Human support across accounts and groups', section: 'Operations', permission: 'team.manage', icon: IconActivity },
  { to: '/billing', label: 'Billing & subscriptions', description: 'Invoices, receipts, balances and terms', section: 'Operations', permission: 'billing.read', icon: IconBarChart },
  { to: '/escalations', label: 'Human handovers', description: 'Review and resolve escalated conversations', section: 'Operations', permission: 'conversations.read', icon: IconAlertCircle, end: true },
  { to: '/escalations/config', label: 'Escalation policy', description: 'Configure timers and responsibility', section: 'Operations', permission: 'conversations.read', icon: IconShieldAlert },
  { to: '/decisions', label: 'Decision history', description: 'Understand how support decisions were made', section: 'Operations', permission: 'conversations.read', icon: IconActivity },
  { to: '/reports', label: 'Reports', description: 'Measure response, workload and outcomes', section: 'Operations', permission: 'reports.view', icon: IconBarChart },
  { to: '/analytics', label: 'Detailed analytics', description: 'Explore account and support breakdowns', section: 'Operations', permission: 'reports.view', icon: IconActivity },
  { to: '/access', label: 'Users & access', description: 'User accounts, roles and sessions', section: 'Administration', permission: 'users.read', icon: IconUsers },
  { to: '/jobs', label: 'Job center', description: 'Inspect background progress and failures', section: 'Administration', permission: 'jobs.read', icon: IconActivity },
  { to: '/notifications', label: 'Notifications', description: 'Personal updates and announcements', section: 'Administration', icon: IconAlertCircle },
  { to: '/changelog', label: 'What’s new', description: 'Published releases and product improvements', section: 'Administration', icon: IconSparkles },
  { to: '/settings', label: 'Settings', description: 'Workspace settings and feature controls', section: 'Administration', permission: 'settings.read', icon: IconSettings, end: true },
  { to: '/settings/rate-limits', label: 'Rate limits', description: 'Sending and automation pacing policies', section: 'Administration', permission: 'settings.read', icon: IconSliders },
  { to: '/emergency', label: 'Emergency controls', description: 'Pause automated actions when needed', section: 'Administration', permission: 'settings.read', icon: IconOctagonAlert },
];

export function availableNavigation(can: (permission: string) => boolean) {
  return NAVIGATION.filter(item => !item.permission || can(item.permission));
}
export function currentDestination(path: string) {
  return [...NAVIGATION].sort((a,b) => b.to.length - a.to.length).find(item => item.to === '/' ? path === '/' : path === item.to || path.startsWith(`${item.to}/`)) ?? NAVIGATION[0];
}
