<script setup lang="ts">
import { useQuery } from '@vue/apollo-composable'
import { LINKAGE_QUERY } from '../api/apollo'
import { useLinkageStore } from '../stores/linkage'

const store = useLinkageStore()
const { result } = useQuery(LINKAGE_QUERY)
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div>
        <p class="eyebrow">FIRE LINKAGE / 消防联动</p>
        <h1>{{ result?.project?.name ?? '消防联动配置项目' }}</h1>
        <p class="muted">{{ result?.project?.building ?? '1号楼 / 2号楼' }} · 设计依据 {{ result?.project?.standard ?? 'GB 50116-2013' }}</p>
      </div>
      <div class="actions">
        <v-btn variant="outlined" prepend-icon="mdi-export-variant">导出配置</v-btn>
        <v-btn color="primary" prepend-icon="mdi-check-decagram-outline" @click="$router.push('/review')">进入审阅</v-btn>
      </div>
    </div>

    <div class="metric-grid">
      <article><span>点位总数</span><strong>{{ store.devices.length }}</strong><small>覆盖 2 个楼层分区</small></article>
      <article><span>重算后满足动作</span><strong>{{ [...store.evaluations.values()].filter((item) => item.effective).length }}</strong><small>{{ store.rules.length }} 条矩阵关系 · {{ store.blockedCount }} 条挂牌失效</small></article>
      <article><span>生效挂牌</span><strong class="warning">{{ store.activeTags.length }}</strong><small>共用依据 {{ store.basisId }}</small></article>
      <article><span>待续作 / 冲突批次</span><strong :class="store.failedBatches.length || store.conflictBatches.length ? 'error' : ''">{{ store.failedBatches.length }} / {{ store.conflictBatches.length }}</strong><small>按批次号续作 · 先到先得</small></article>
    </div>

    <div class="overview-grid">
      <section class="panel">
        <div class="panel-head"><h3>矩阵完整性</h3><v-chip size="small" color="success" variant="tonal">重算满足 {{ store.devices.filter((device) => store.rules.some((rule) => rule.triggerId === device.id && store.evaluationOf(rule.id)?.effective)).length }}/{{ store.devices.filter((device) => ['感烟探测器','感温探测器','手动报警按钮'].includes(device.type)).length }} 探测回路</v-chip></div>
        <div class="coverage-list">
          <div v-for="device in store.devices.filter((item) => ['感烟探测器','感温探测器','手动报警按钮'].includes(item.type))" :key="device.id">
            <div><strong>{{ device.name }}</strong><small>{{ device.floor }} / {{ device.zone }} · {{ device.address }}</small></div>
            <v-chip size="small" :color="store.rules.some((rule) => rule.triggerId === device.id && store.evaluationOf(rule.id)?.effective) ? 'success' : store.taggedDeviceIds.has(device.id) ? 'warning' : 'error'" variant="tonal">
              <template v-if="store.taggedDeviceIds.has(device.id)">挂牌隔离中</template>
              <template v-else-if="store.rules.filter((rule) => rule.triggerId === device.id && store.evaluationOf(rule.id)?.effective).length">{{ store.rules.filter((rule) => rule.triggerId === device.id && store.evaluationOf(rule.id)?.effective).length }} 个动作满足</template>
              <template v-else>缺少动作</template>
            </v-chip>
          </div>
        </div>
      </section>
      <aside class="panel">
        <div class="panel-head"><h3>专业协同进度</h3><span class="muted">当前版本 R{{ store.revision }} · {{ store.basisId }}</span></div>
        <div class="review-progress">
          <div><span>消防电专业</span><v-progress-linear :model-value="92" color="primary" height="7" rounded /><strong>92%</strong></div>
          <div><span>暖通专业</span><v-progress-linear :model-value="76" color="secondary" height="7" rounded /><strong>76%</strong></div>
          <div><span>智能化专业</span><v-progress-linear :model-value="64" color="warning" height="7" rounded /><strong>64%</strong></div>
          <v-alert type="warning" variant="tonal" density="compact" class="mt-4">夜班挂牌 {{ store.activeTags.length }} 个范围生效，{{ store.blockedCount }} 条规则已按依据 {{ store.basisId }} 失效重算；疏散动作 {{ store.evacuationActions.length }} 项按已签优先级继续。</v-alert>
          <v-btn variant="tonal" prepend-icon="mdi-tag-lock-outline" @click="$router.push('/lockout')">进入挂牌与批次</v-btn>
        </div>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.metric-grid { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 12px; margin-bottom: 14px; }
.metric-grid article { padding: 16px; border: 1px solid #dde3e3; border-radius: 10px; background: white; }
.metric-grid span, .metric-grid small { display: block; color: #758187; font-size: 12px; }
.metric-grid strong { display: block; margin: 7px 0; color: #293e45; font-size: 28px; }
.metric-grid .error { color: #b23e2a; }
.metric-grid .warning { color: #bd7928; }
.overview-grid { display: grid; grid-template-columns: minmax(0,1fr) 330px; gap: 14px; }
.coverage-list { padding: 6px 16px 14px; }
.coverage-list > div { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 0; border-bottom: 1px solid #edf0f0; }
.coverage-list strong, .coverage-list small { display: block; }
.coverage-list small { margin-top: 4px; color: #7b878c; }
.review-progress { display: grid; gap: 18px; padding: 20px; }
.review-progress > div { display: grid; grid-template-columns: 82px 1fr 36px; align-items: center; gap: 10px; font-size: 12px; }
@media (max-width: 1000px) { .overview-grid { grid-template-columns: 1fr; } }
@media (max-width: 680px) { .metric-grid { grid-template-columns: 1fr 1fr; } }
</style>
