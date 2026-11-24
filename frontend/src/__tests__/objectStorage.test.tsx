import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import api from '../lib/api'
import ObjectStorage from '../pages/ObjectStorage'
import { useOrgStore } from '../store/orgStore'
import { cloudServiceLabel, recommendationTitle } from '../lib/objectStorage'

vi.mock('../lib/api', () => ({ default: { get: vi.fn() } }))
const get=vi.mocked(api.get)
const org=(scope:'pre'|'prod')=>({id:scope,name:scope,slug:scope,workspace:{id:'shared',name:'Shared catalog',environment:scope}})
const bucket={id:'bucket-1',name:'finance-reports',ci_id:'ci-1',cloud_account_id:'account',account_name:'First account',provider:'alibaba',region:'cn-hongkong',owners:[],cost:0}
const overview={buckets:[bucket,{...bucket,id:'bucket-2',name:'archive-reports',cost:null}],accounts:[{id:'account',name:'First account'}],allocation:[],bucket_count:2,unclaimed_count:2,billed_count:1,period_cost:0,allocated_cost:0,unallocated_cost:0,excluded_currency_rows:0,currency:'CNY',can_bind:false,can_import:false,can_allocate:false}
const details={...bucket,environment:'pre',cloud_resource_id:bucket.name,last_seen:'2026-10-01T00:00:00Z',tags:{env:'pre'},usage:{object_count:null,size_bytes:null,covered_objects:null,covered_bytes:null,latest_at:null,full_at:null},trend:[],breakdown:[],imports:[],rules:[],service_costs:[]}
function show(url='/object-storage'){
 const qc=new QueryClient({defaultOptions:{queries:{retry:false}}})
 return render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={[url]}><ObjectStorage/></MemoryRouter></QueryClientProvider>)
}
beforeEach(()=>{
 useOrgStore.getState().setCurrentOrg(org('pre'))
 get.mockReset().mockImplementation(async url=>{
   const meta={page:1,total_pages:1,per_page:20,total:2}
   if(url==='/orgs/pre/object-storage')return {data:{data:overview,meta}}
   if(url==='/orgs/pre/object-storage/buckets/bucket-1')return {data:{data:details}}
   if(url.endsWith('/opportunities'))return {data:{data:{groups:[],names:[],currency:'CNY'},meta}}
   if(url.endsWith('/bills'))return {data:{data:[],meta}}
   if(url==='/orgs/prod/object-storage')return {data:{data:{...overview,buckets:[],accounts:[],bucket_count:0,unclaimed_count:0,billed_count:0,period_cost:null},meta}}
   throw Error('Unexpected API call')
 })
})
it('shows actual zero and missing bills separately, and leaves duplicate analysis on demand', async()=>{
 show('/object-storage?service=shared-service')
 const table=await screen.findByRole('table')
 expect(within(table).getByRole('row',{name:/finance-reports/})).toHaveTextContent('0.00')
 expect(within(table).getByRole('row',{name:/archive-reports/})).toHaveTextContent('No matched bill')
 expect(get.mock.calls.some(([url])=>url.includes('duplicates')||url.includes('opportunities'))).toBe(false)
 expect(get.mock.calls[0][1]).toMatchObject({params:{service_id:'shared-service'}})
 await userEvent.click(within(table).getByRole('button',{name:'finance-reports'}))
 const dialog=await screen.findByRole('dialog')
 expect(await within(dialog).findByText('This bucket has no business service assigned.')).toBeInTheDocument()
 expect(within(dialog).queryByRole('button',{name:'Link service'})).not.toBeInTheDocument()
 await userEvent.click(within(dialog).getByRole('button',{name:'Cost and usage'}))
 expect(within(dialog).getAllByText('Not collected')).toHaveLength(2)
 await userEvent.click(within(dialog).getByRole('button',{name:'Opportunities'}))
 await within(dialog).findByText('Import an object inventory to evaluate duplicate content.')
 expect(within(dialog).queryByRole('button',{name:'Import inventory'})).not.toBeInTheDocument()
})
it('loads an independent empty inventory for the other environment',async()=>{
 show();await screen.findByRole('button',{name:'finance-reports'})
 act(()=>useOrgStore.getState().setCurrentOrg(org('prod')))
 await screen.findByText('No object storage buckets have been discovered in this scope.')
 await waitFor(()=>expect(screen.queryByText('finance-reports')).not.toBeInTheDocument())
})
it('localizes provider product labels without editing identifiers inside a resource name',()=>{
 expect(cloudServiceLabel('Aliyun OSS')).toContain('Object Storage')
 expect(cloudServiceLabel('Amazon S3')).toContain('AWS')
 expect(cloudServiceLabel('OSS-archive-account')).toBe('OSS-archive-account')
 expect(recommendationTitle({rec_type:'abandoned_s3_bucket',title:'Abandoned S3 Bucket: finance-S3-archive'})).toBe('Idle object storage bucket · finance-S3-archive')
})
