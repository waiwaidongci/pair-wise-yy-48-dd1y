import { createRouter, createWebHashHistory } from 'vue-router'
import OverviewView from './views/OverviewView.vue'
import DevicesView from './views/DevicesView.vue'
import TagsView from './views/TagsView.vue'
import MatrixView from './views/MatrixView.vue'
import DependencyView from './views/DependencyView.vue'
import ReviewView from './views/ReviewView.vue'

export default createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', component: OverviewView, meta: { title: '项目总览' } },
    { path: '/devices', component: DevicesView, meta: { title: '设备与分区' } },
    { path: '/lockout', component: TagsView, meta: { title: '挂牌与批次' } },
    { path: '/matrix', component: MatrixView, meta: { title: '因果矩阵' } },
    { path: '/dependency', component: DependencyView, meta: { title: '依赖图' } },
    { path: '/review', component: ReviewView, meta: { title: '版本审阅' } },
  ],
})
