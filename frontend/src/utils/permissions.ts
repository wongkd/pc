export const has = (permissions: readonly string[], permission: string) => permissions.includes('*') || permissions.includes(permission)
