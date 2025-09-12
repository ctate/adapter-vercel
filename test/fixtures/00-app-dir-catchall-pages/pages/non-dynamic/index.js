export function getServerSideProps() {
  return {
    props: {
      now: Date.now(),
    },
  };
}

export default function Page(props) {
  return (
    <>
      <p>non-dynamic</p>
      <pre>{JSON.stringify(props, null, 2)}</pre>
    </>
  );
}
