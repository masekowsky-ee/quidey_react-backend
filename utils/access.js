// Who may do what, from a users row (needs is_pro, is_tester, is_admin).

// Closed beta: the app is for pro users and testers; admins always get in,
// so they can't lock themselves out of the admin panel.
const hasAppAccess = (account) => Boolean(account.is_pro || account.is_tester || account.is_admin);

// Features not released to everyone yet: testers, and admins always.
const hasTesterAccess = (account) => Boolean(account.is_tester || account.is_admin);

// The same as hasAppAccess, for SQL on the users table
const APP_ACCESS_SQL = "(users.is_pro OR users.is_tester OR users.is_admin)";

module.exports = { hasAppAccess, hasTesterAccess, APP_ACCESS_SQL };
