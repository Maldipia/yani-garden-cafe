export default async function handler(req, res) {
  const key = process.env.SUPABASE_SECRET_KEY || 'NOT_SET';
  return res.status(200).json({
    hasKey: key !== 'NOT_SET',
    keyPrefix: key.substring(0, 20),
    isSecret: key.startsWith('sb_secret_') || key.startsWith('eyJ'),
    isAnon: key.startsWith('sb_publishable_'),
  });
}
