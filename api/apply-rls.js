// TEMPORARY: One-time diagnostic endpoint
export default async function handler(req, res) {
  // Show all env var names (not values) to debug what's available
  const envKeys = Object.keys(process.env).filter(k => 
    k.includes('SUPA') || k.includes('KEY') || k.includes('SECRET') || k.includes('TOKEN')
  );
  
  const SECRET = process.env.SUPABASE_SECRET_KEY || 
                 process.env.SUPABASE_SERVICE_ROLE_KEY || 
                 process.env.SUPABASE_SERVICE_KEY ||
                 process.env.SERVICE_ROLE_KEY;
  
  return res.status(200).json({
    availableKeys: envKeys,
    hasSecret: !!SECRET,
    secretPrefix: SECRET ? SECRET.substring(0, 25) + '...' : 'none',
    nodeEnv: process.env.NODE_ENV,
  });
}
