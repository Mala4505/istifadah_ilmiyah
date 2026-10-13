import { createClient } from '@supabase/supabase-js'
import * as fs from 'node:fs'
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } })
const e = await s.from('entries').select('id,type,ubbl_number,budget_head_id,invoice_number,vendor_raw,date,amount,status_raw,is_void').eq('department_id', 290).limit(5000)
fs.writeFileSync(process.argv[2], JSON.stringify(e.data))
