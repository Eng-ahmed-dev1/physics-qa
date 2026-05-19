const { createClient } = require('@supabase/supabase-js');

let supabase = null;

if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
} else {
    console.warn('Supabase URL or Key is missing. Falling back to in-memory state.');
}

module.exports = supabase;
