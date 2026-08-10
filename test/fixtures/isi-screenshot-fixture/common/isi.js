(function () {
  const bindHandler = (fn, context) => (...args) => fn.apply(context, args)

  const ISI = function (id) {
    this.scroller = document.getElementById(id)
    if (!this.scroller) {
      return
    }

    const parent = this.scroller.parentNode
    if (!parent) {
      return
    }

    this.scrollbar = document.createElement('div')
    this.scrollbar.className = 'iScrollVerticalScrollbar'
    this.scrollbar.innerHTML = '<div class="iScrollIndicator"></div>'
    parent.insertBefore(this.scrollbar, parent.firstChild)
    this.scrollIndicator = parent.querySelector('.iScrollIndicator')
    this.containerHeight = parent.clientHeight
    this.scrollerHeight = Math.max(0, this.scroller.scrollHeight - this.containerHeight)
    this.scrollerY = 0
    this.animate = bindHandler(this.animate, this)
    this.startDelayTimeout = setTimeout(() => {
      this.autoplayID = window.requestAnimationFrame(this.animate)
    }, 100)
  }

  ISI.prototype.animate = function () {
    this.scrollerY = Math.max(-this.scrollerHeight, this.scrollerY - 4)
    this.scroller.style.transform = `translateY(${this.scrollerY}px)`
    if (this.scrollerY > -this.scrollerHeight) {
      this.autoplayID = window.requestAnimationFrame(this.animate)
    }
  }

  window.ISI = ISI
})()
