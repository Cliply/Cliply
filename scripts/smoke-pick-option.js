// Use the same trigger and visible option that a user selects in Electron.
async function pickOption(js, id, value) {
  const trigger = `document.getElementById(${JSON.stringify(id)})`
  await js(`${trigger}.click()`)
  await js(`(() => {
    const list = document.getElementById(${trigger}.getAttribute("aria-controls"))
    const option = Array.from(list.querySelectorAll('[role="option"]'))
      .find(row => row.dataset.value === ${JSON.stringify(value)})
    if (!option) throw new Error("Missing picker option")
    option.click()
  })()`)
}
module.exports = { pickOption }
