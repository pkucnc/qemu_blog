import { defineConfig } from 'vitepress'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: "CLab QEMU Internals",
  description: "QEMU internals",
  srcExclude: ['README.md'],
  cleanUrls: true,
  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    nav: [
      { text: 'Home', link: '/introduction' },
    ],

    sidebar: [
      {
        text: 'QEMU Internals',
        items: [
          { text: '00 Introduction', link: '/' },
          { text: '01 Creating a new machine', link: '/machine' },
          { text: '02 Controlling memory regions', link: '/regions' },
          { text: '03 Creating interrupts controller and new devices', link: '/devices' },
          { text: '04 Timers', link: '/timers' },
          { text: '05 Execution loop and accelerators', link: '/exec' },
          { text: '06 Breakpoints handling', link: '/brk' },
          { text: '07 VM running states', link: '/runstate' },
          { text: '08 VM Snapshotting', link: '/snapshot' }
        ]
      },
      {
        text: 'TCG Internals',
        items: [
          { text: '01 TCG IR', link: '/tcg_ir' },
          { text: '02 TCG Host code generation', link: '/tcg_host' },
          { text: '03 TCG TCG Memory Operations', link: '/tcg_mem' }
        ]
      },
      {
        text: 'PCIe Internals',
        items: [
          { text: '01 PCIe overview', link: '/pcie_intro' },
          { text: '02 PCIe controller emulation', link: '/pcie_ctl' },
          { text: '03 PCIe device emulation', link: '/pcie_device' }
        ]
      }
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/pkucnc/qemu_blog' }
    ],
    editLink: {
      pattern: 'https://github.com/pkucnc/qemu_blog/edit/main/:path'
    }
  }
})
